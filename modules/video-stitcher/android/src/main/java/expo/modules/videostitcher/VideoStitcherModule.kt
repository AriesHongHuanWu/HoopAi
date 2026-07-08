package expo.modules.videostitcher

import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** One stitch window in SECONDS of source time (sanitized in TS, re-clamped here). */
class StitchSegment : Record {
  @Field var startSec: Double = 0.0
  @Field var endSec: Double = 0.0
}

class StitchOptions : Record {
  @Field var sourceUri: String = ""
  @Field var segments: List<StitchSegment> = emptyList()
  @Field var outputFileName: String? = null
}

/** Coded errors surfaced to JS as `error.code`. */
private class NoSourceException :
  CodedException("ERR_NO_SOURCE", "sourceUri is empty or invalid.", null)
private class NoSegmentsException(message: String) :
  CodedException("ERR_NO_SEGMENTS", message, null)
private class OutputException :
  CodedException("ERR_OUTPUT", "Could not prepare the output file.", null)
private class ExportFailedException(cause: Throwable?) :
  CodedException("ERR_EXPORT_FAILED", "Export failed: ${cause?.localizedMessage ?: "unknown"}", cause)

class VideoStitcherModule : Module() {
  /** Retained so cancel() can reach the running transform. Main-thread only. */
  private var activeTransformer: Transformer? = null

  override fun definition() = ModuleDefinition {
    Name("VideoStitcher")

    // { index, total } per appended clip. media3 doesn't give per-clip build
    // callbacks, so we emit as we assemble the sequence (before export runs).
    Events("onProgress")

    Function("isAvailable") {
      // Reaching native at all means it linked; the TS guard covers "missing".
      true
    }

    Function("cancel") {
      // Transformer.cancel() must run on the thread that created it (main).
      appContext.mainQueue.run {
        activeTransformer?.cancel()
        activeTransformer = null
      }
    }

    AsyncFunction("stitch") Coroutine { options: StitchOptions ->
      return@Coroutine stitch(options)
    }
  }

  private suspend fun stitch(options: StitchOptions): Map<String, Any> {
    val source = options.sourceUri.trim()
    if (source.isEmpty()) throw NoSourceException()
    if (options.segments.isEmpty()) throw NoSegmentsException("No segments to stitch.")

    // Build the clipped sequence. Each segment → a MediaItem with a clipping
    // config; degenerate windows are dropped. Progress fires per kept clip.
    val total = options.segments.size
    val edited = ArrayList<EditedMediaItem>(total)
    options.segments.forEachIndexed { i, seg ->
      val startS = seg.startSec.coerceAtLeast(0.0)
      val endS = seg.endSec.coerceAtLeast(0.0)
      if (endS - startS <= 0.02) return@forEachIndexed

      val clip = MediaItem.ClippingConfiguration.Builder()
        .setStartPositionMs((startS * 1000).toLong())
        .setEndPositionMs((endS * 1000).toLong())
        .build()
      val mediaItem = MediaItem.Builder()
        .setUri(Uri.parse(source))
        .setClippingConfiguration(clip)
        .build()
      edited.add(EditedMediaItem.Builder(mediaItem).build())
      sendEvent("onProgress", Bundle().apply {
        putInt("index", i)
        putInt("total", total)
      })
    }

    if (edited.isEmpty()) {
      throw NoSegmentsException("None of the segments fell inside the video.")
    }

    val outputFile = try {
      makeOutputFile(options.outputFileName)
    } catch (e: Exception) {
      throw OutputException()
    }

    val sequence = EditedMediaItemSequence(edited)
    val composition = Composition.Builder(sequence).build()

    // Transformer requires a Looper thread; run its lifecycle on the main queue
    // and suspend until its listener fires. Transmux (no re-encode) is the
    // default when the clips share the source's codec — fast, seconds not minutes.
    return withContext(Dispatchers.Main) {
      suspendCancellableCoroutine { cont ->
        val transformer = Transformer.Builder(appContext.reactContext!!)
          .setVideoMimeType(MimeTypes.VIDEO_H264)
          .addListener(object : Transformer.Listener {
            override fun onCompleted(composition: Composition, result: ExportResult) {
              activeTransformer = null
              val durationSec = if (result.durationMs > 0) result.durationMs / 1000.0 else 0.0
              cont.resume(
                mapOf(
                  "uri" to Uri.fromFile(outputFile).toString(),
                  "durationSec" to durationSec,
                )
              )
            }

            override fun onError(
              composition: Composition,
              result: ExportResult,
              exception: ExportException,
            ) {
              activeTransformer = null
              outputFile.delete()
              cont.resumeWithException(ExportFailedException(exception))
            }
          })
          .build()

        activeTransformer = transformer
        cont.invokeOnCancellation {
          transformer.cancel()
          activeTransformer = null
          outputFile.delete()
        }
        try {
          transformer.start(composition, outputFile.absolutePath)
        } catch (e: Exception) {
          activeTransformer = null
          cont.resumeWithException(ExportFailedException(e))
        }
      }
    }
  }

  /** A writable output path in the cache dir. Reels are ephemeral share artifacts. */
  private fun makeOutputFile(fileName: String?): File {
    val cacheDir = appContext.reactContext?.cacheDir
      ?: throw IllegalStateException("No cache directory available.")
    val dir = File(cacheDir, "reels").apply { mkdirs() }

    var base = if (!fileName.isNullOrEmpty()) fileName else "reel-${System.currentTimeMillis()}"
    if (base.lowercase().endsWith(".mp4")) base = base.dropLast(4)
    // Strip separators so a caller-supplied name can't escape the dir.
    base = base.replace("/", "-").replace("\\", "-")

    val file = File(dir, "$base.mp4")
    if (file.exists()) file.delete()
    return file
  }
}
