/**
 * Device video-library helpers for session recordings.
 *
 * Everything here is NEVER-THROW: these run in post-session flows where a
 * failed save or delete must degrade to a boolean / no-op, not a crash.
 * Paths may arrive with or without the file:// scheme (VisionCamera hands
 * back bare paths; expo APIs prefer URIs), so both forms are handled.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';

/** Ensure a file:// scheme so expo-file-system / media-library accept it. */
function toFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

/** Strip the file:// scheme (the alternate form some APIs return). */
function toBarePath(path: string): string {
  return path.startsWith('file://') ? path.slice('file://'.length) : path;
}

/**
 * Whether the recording file still exists on disk. Tries both the file:// and
 * bare-path forms; any filesystem error reads as "missing".
 */
export async function localVideoExists(path: string | null | undefined): Promise<boolean> {
  if (path == null || path.length === 0) return false;
  try {
    const info = await FileSystem.getInfoAsync(toFileUri(path));
    if (info.exists) return true;
  } catch {
    // Fall through to the alternate form.
  }
  try {
    const info = await FileSystem.getInfoAsync(toBarePath(path));
    return info.exists;
  } catch {
    return false;
  }
}

/**
 * Save a session recording to the user's photo library.
 *
 * Requests write-only (add-only) permission where the platform supports it,
 * then saves via saveToLibraryAsync with createAssetAsync as a fallback.
 *
 * @returns true when the video landed in the library; false on missing file,
 *   denied permission or any save failure. Never throws.
 */
export async function saveSessionVideo(path: string | null | undefined): Promise<boolean> {
  if (path == null || path.length === 0) return false;
  try {
    if (!(await localVideoExists(path))) {
      console.warn('[videoLibrary] Recording file missing, skipping save', path);
      return false;
    }
    // writeOnly → iOS "add only" prompt; Android maps to the closest scope.
    const permission = await MediaLibrary.requestPermissionsAsync(true);
    if (!permission.granted) return false;
    const uri = toFileUri(path);
    try {
      await MediaLibrary.saveToLibraryAsync(uri);
      return true;
    } catch (saveErr) {
      console.warn('[videoLibrary] saveToLibraryAsync failed, trying createAssetAsync', saveErr);
      await MediaLibrary.createAssetAsync(uri);
      return true;
    }
  } catch (err) {
    console.warn('[videoLibrary] Could not save video to library', err);
    return false;
  }
}

/**
 * Best-effort delete of a local recording file (e.g. when its session is
 * deleted). Missing files and filesystem errors are silently absorbed.
 */
export async function deleteLocalVideo(path: string | null | undefined): Promise<void> {
  if (path == null || path.length === 0) return;
  try {
    await FileSystem.deleteAsync(toFileUri(path), { idempotent: true });
  } catch (err) {
    console.warn('[videoLibrary] Could not delete local video', err);
  }
}
