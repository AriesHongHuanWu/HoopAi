# HOOPILOT 主計畫 v2(一年執行版)

> **用途**:未來 AI session 與開發者的完整接手檔 + 從現在到「最完成體 v3.0」的一年執行路線。
> 讀完你應該知道:現在在哪、終點長什麼樣、每一季做什麼、每個工作項的驗收標準、什麼不要重新辯論。
> **執行規則**:照 §4 backlog 依 ID 順序/依賴執行;每完成一項在該行標 ✅+commit hash;方向性改動必須更新本檔。
> 最後更新:2026-07-10(v2.1,171-agent mega-upgrade 波次)。前版:2026-07-08 v2(cd52b30)。

---

## §0 AI 接手須知(先讀這段)

**專案**:Hoopilot — 手機單鏡頭即時籃球投籃追蹤 app(iOS+Android),完全 on-device,免帳號。
Repo:`AriesHongHuanWu/HoopAi`,本機 `C:\Users\aries\claude\claudeCode\hoop-ai`。

**指令**:
- 驗證:`npx tsc --noEmit && npx jest`(基準 1976 tests,全綠才能 commit)
- iOS IPA:`gh workflow run ios-ipa.yml`(~16 分 → `ios-ipa-latest` release);Android:push main 自動(~37 分 → `android-latest`)
- 模型驗證:`python tools/validate_model.py --model X.tflite --video <真實影片> --fps 6 --size 416|640 --compare <現役asset>`
- 側載:Sideloadly + USB;使用者自己輸 Apple ID(AI 絕不碰帳密)

**鐵律(每條都是真實事故換來的)**:
1. 不在使用者本機訓練(GPU 過熱)— 訓練上 Kaggle/Colab/Lightning;本機只做 CPU 轉檔
2. 程式碼/註解全英文;commit 結尾加當前 Claude 模型的 Co-Authored-By trailer(如 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`)
3. 絕不代打帳密/金鑰;Kaggle kernel 純 ASCII;kaggle CLI 要 `PYTHONUTF8=1`
4. ROI 二次偵測只能貢獻 `ball`,絕不注入 `ball_in_basket`(假進球)
5. 佐證器(virtual crossing/reappearance)只升級 `geo null→true` 且需 net/cls 同意;絕不單獨定案、絕不翻已判定的球
6. 換模型前必過 `validate_model.py` 實測影片對比(val 分數會騙人:curated-Tiny 事件 val 0.922 實測更爛)
7. 多 agent worktree:互斥檔案所有權;ui.tsx/tokens.ts 唯讀;**刪 worktree 前先 `Get-Item -Force` 查 node_modules junction 並 `.Delete()` 解鏈**(否則刪穿主 repo);主 session cwd 非 git repo 時 isolation:'worktree' 會失敗 → 叫 agent 自己 `git worktree add`
8. 寫碼前讀 `AGENTS.md`(Expo v57 版本文件)
9. 合併多 agent 成果後必跑 4-lens 整合審查 workflow(15 agent 兩波曾漏 16 個整合 bug)

**關鍵檔案地圖**:
| 層 | 檔案 |
|---|---|
| 偵測核心(純 TS、可重放) | `src/core/shotFsm.ts`(三訊號融合+4 arm 路徑)、`ballTracker.ts`、`rimLock.ts`、`trajectory.ts`、`recheck.ts` |
| 佐證/幾何 | `reappearance.ts`、`depthRatioGate.ts`、`courtGeometric.ts`、`ftCalibration.ts`、`lightProfile.ts`、`placementGrade.ts`、`viewBand.ts` |
| 相機/ML 熱路徑 | `src/camera/useShotEngine.ts`(worklet)、`src/ml/yoloParser.ts`、`letterboxCull.ts`、`roiTransform.ts`、`motionCandidate.ts`(OFF) |
| 資料 | `src/data/db.ts`(SQLite v6)、`hardExamples.ts`、`recheckRunner.ts`、`videoLibrary.ts` |
| 遊戲/社群 | `src/core/gameModes.ts`(8 模式含 ghost)、`dailyChallenges.ts`、`achievements.ts`、`nbaBenchmarks.ts`、`shotLab.ts` |
| 分享 | `ShareCard.tsx`(feed/story/twin)、`reel/[sessionId].tsx`、`BrandMark.tsx`、`shareFrame.ts` |
| 商業骨架 | `src/core/premium.ts`(entitlements 已定義未接線) |
| 訓練/工具 | `training/yolox/`、`tools/validate_model.py`、`tools/quantize_tflite.py`、kernel 腳本在 repo 根 |
| 研究存檔 | `docs/research/competitors-2026-07.md`(競品+build list)、本檔 |

---

## §1 現況快照(2026-07-10,mega-upgrade 波次後)

**2026-07-10 Round-2 mega-upgrade(13 偵察/設計 + 29 實作/整合 + 57 審查/驗證/修復;1976 tests 全綠):**
- **FT-seed 場地定位(旗艦)**:`src/core/ftSeed.ts` — 開場罰球錨定(已知 FT 線距離反解 scale+yaw 修正)→ 任意鏡頭擺位的每球場上位置 + corner-accurate 2/3;provenance 新增 `ftSeed`(FT-anchored)層(court > ftSeed > metric > heuristic);信心上限 0.75 誠實封頂;live 的 `FtSeedChip` 儀式化引導;seed 亦回饋 shrink-only 球尺寸上限給 tracker。判定路徑零影響(只動 shotValue/位置)。rim 漂移/re-aim 會同步清 seed。
- **追蹤斷鏈修復**:`acquisitionFunnel.ts` 漏斗遙測(raw→cull→gate→tracked→drawn + 最後拒絕原因,進 DebugPanel/COPY DIAG)、flag-gated 持續性救援(高分未收養球連續 N 幀→放行冷門檻,recall-only)、FSM `armRefusal` 記錄口徑、DetectionBoxes 雙層框(raw vs tracked)、dribbleGate 陳舊 latch/apex 跨界加固。
- **模式分類 IA**:Train 分頁改 QUICK START/GAMES/CHALLENGES/TOOLS 分區 + 使用紀錄驅動的推薦 hero;全部 arm-then-route/deep-link/ghost picker 契約保留。
- **Setup 一鍵開始**:頂部 StartHero(上次設定摘要 chip)+ 摺疊選項段 + sticky 底欄;settingsStore v7。
- **動畫系統**:`src/components/motion/`(stagger/CountUp/MotionStat/SuccessBurst/AnimatedProgressBar/Shimmer/PressScale)+ gated haptics util;home/coach/history/trends/records/summary(PB 彩帶)/jump/profile/reel 全鋪;全部尊重 reduced-motion。
- **3D v2**:視角預設(SIDE/FRONT/TOP)平滑 tween、自動環繞、手腕軌跡緞帶、release 幀場景內角度標註、兩球對比(誠實「estimated reconstruction」)、Stage3DStill 分享圖、首開導覽。
- **教學層**:live 聚光燈 CoachMarks、HintChip 情境提示、校正指南 Skia 動畫場景、`/how-it-works` 偵測原理誠實說明頁、summary 誠實文案修正(改判不會訓練模型)。
- 審查波抓到 13 個確認 bug 全修/處置(最重:stale FT-seed 回饋會假告「已錨定」+ rim 漂移不清 seed → 都修掉)。


**2026-07-10 171-agent mega-upgrade(21 偵察/設計 + 45 實作/整合 + 101 審查/驗證/修復 + 4 收尾;1502 tests 全綠):**
- **偵測**:多球熱身防護(suppression-only `multiBallGuard` + FSM `armLockout`,吃 per-model cold gate)、籃框撞歪 settle-boost 重鎖 + drift 期 arm 鎖(`rimGuard`)、推論延遲熱調速器(`thermalGovernor` L0-L3,model reload 會 reset)、鏡頭眩光/霧化自檢 advisory(`lensCheck`,HUD chip + DebugPanel lens/thermal 列)、追蹤走廊 capsule + 重力感知投影。淨 ROI 相位假爆發 bug(會鑄假 make)已在審查波抓到修掉(rect 移動時 diff 基線失效化)。
- **軌跡 HUD**:`arcHudGeometry`(解析導數版 release/entry angle)、TrajectoryOverlay 分級弧色+頂點標記+錐形彗尾、ArcReadout 即時角度 chip、`MiniArcReplay` 每球迷你弧重播(ShotList SessionRecap)。純視覺,不 arm 不判定。
- **Form Studio 3D**:`src/core/pose3d/`(lift/camera3d/angles3d,純 TS 有測試)2D→3D 人體測量學提升(誠實標示 estimated)、純 Skia 透視投影+拖曳軌道相機、`FormStage3D` + `/formstudio3d` 畫面(播放刮擦、release 凍結、關節角讀數、NBA ghost 對照);`replay3d` 設定可關。
- **校正教學**:`calibrationGuide` 引擎 + `/calibration-guide` 互動教學(擺位教練/籃框鎖定清單/點場走查/FT wizard)、`CalibrationHealthCard`(setup+settings)、court-tap 品質分級(dialed/good/rough)+ 成功卡。
- **教練完整性**:冷區 finding→drill、過去 4 週 coach 時間軸、form-readiness 指標、season strip、`drillProgression` 難度等級(deep-link 帶 level 起 drill)、coach 報告分享卡。audit backlog rank6/8/9 完成。
- **透明化+流程**:`detectionHealth` HUD 面板、`ShotReceipt` 可展開三訊號收據(corrected 誠實敘事)、unsure 批次 triage、GoalChip/熱度階梯/FormCueToast、`sessionStory` 總結敘事、Run-it-back 快速重開(保留 drill level)。
- **資料**:db v9(arc snapshot + form keyframes 持久化,lazy decode)、settingsStore v6(新開關+遷移)、backup 匯入 shot PK 碰撞修復(AUTOINCREMENT 重派)、`replayQueries` 讀取層(部分消費端尚未建——arc 縮圖牆待做)。
- **品質**:`ironRules.invariants` + `purity.static` + `settingsMigration` 守衛套件、docs/QUALITY-GATES.md、docs/INTEGRATION-REVIEW.md、docs/SMOKE-CHECKLIST.md(使用者實機煙霧清單)。
- **待實機驗證**:所有相機/HUD/3D 畫面(Windows 無法跑 RN)——照 docs/SMOKE-CHECKLIST.md 走一輪。

### 前版快照(2026-07-08,HEAD d6a1690+)

**偵測管線**:小球特化 YOLOX-Tiny(416/640)→ worklet 解析+letterbox 剔除 → Kalman(飛行 0.12/暗光冷啟 0.16)→ ShotFsm 三訊號融合(geo/net/cls)、4 arm 路徑(jump/layup/descend/release-pose)、佐證器×2、防護(pass-through、卡球、putback、雙計冷卻)、3A rim lock、ROI zoom、離線重判。

**實測(296 幀真實影片)**:球冷啟動 @416 **3.4%→61.5%**、追蹤帶 **6.4%→72.0%**;@640 冷啟 9.5%→38.6%(追蹤 −3)。**416 實測勝 640。**

**已上線**:即時 HUD+彗尾+落點預測、錄影+自動剪輯、證據收據+滑動改判+Undo、離線重判、8 遊戲模式(含 Ghost Challenge)、每日挑戰+積分、26 徽章、Shot Lab(12 NBA 原型)、IG 卡×3+Reel+浮水印、語音報分+連勝、罰球線校正(選配)、幽靈籃框引導、BootIntro、暗光 profile、資料飛輪匯出。

**Flag 狀態**:depthVeto=OFF、reappearance=OFF、useViewBandRouting=OFF、motionAssist=OFF(皆已寫好+測試,等資料驗證);metric23=OFF 但 FT 校正成功即啟用;roiZoom=ON。

**等待中**:實機延遲數據(決定 perfMode 預設)、Lightning.ai EfficientDet(備援)、Meta App ID(IG 深度)、$99 Apple 開發者帳號(上架)。

---

## §2 最完成體 v3.0 定義(一年後的驗收)

一年後的 Hoopilot 應同時滿足:

**產品**:App Store+Play Store 雙上架;新用戶從安裝到第一顆被計分的球 <90 秒;免帳號核心完整;Pro 訂閱運轉;教練面板有付費隊伍。
**準度(公開頁數字)**:側面架設進球判定 ≥92%;任意擺放 ≥85%;飛行幀偵測 ≥55%;2/3 分(校準後)≥90%;unsure 率 <8%(重判後 <4%)。
**效能**:主流機(A14+/驍龍 8xx)偵測 ≥25fps;iPhone XR ≥15fps;session 1 小時不過熱降級。
**社群**:Ghost 對戰可跨裝置分享;誠實排行榜上線;每週留存 ≥25%;每 10 場 session 產生 ≥1 次社群分享。
**商業**:免費→Pro 轉換 ≥3%;月費 $4.99 + 買斷 $29.99 並行;≥10 支付費球隊;月收入足以覆蓋 $99+雲端雜支並有盈餘。
**資料**:難例集 ≥10k 標註球;per-condition eval set ≥2k 球;每季一輪重訓;模型無關架構驗證過(至少換過一次底層模型無痛)。

---

## §3 一年路線圖總覽

| 季 | 主題 | 關鍵交付 | 出口條件(過了才進下一季) |
|---|---|---|---|
| **Q1(月 1-3)** | 上架與地基 | 雙商店上架、公開準度頁 v1、int8 提速、實機遙測、飛輪第一輪重訓 | 兩店可下載;準度頁有真數字;主流機 ≥20fps |
| **Q2(月 4-6)** | 偵測完全體 | flag 全數轉正(資料驗證)、多人場景 v1、AR drill 模式、教練建議引擎 | 側面判定 ≥90% 公開數字;drill 模式日活躍使用 |
| **Q3(月 7-9)** | 社群與成長 | Ghost 跨裝置、誠實排行榜、教練 B2B 面板、IG 深度整合、挑戰賽 | 首批付費球隊;週留存 ≥20% |
| **Q4(月 10-12)** | 商業化與擴張 | Pro 全面推出、買斷選項、Watch/雙機位實驗、裁判輔助研究、v3.0 收斂 | §2 全部指標達標或有明確差距分析 |

**節奏**:每雙週一個 release(IPA+APK);每月一次全量回歸(replay harness 全 eval set);每季一輪模型重訓+準度頁更新;每次大合併後 4-lens 整合審查。

---

## §4 工作項 Backlog(依 ID 執行,完成標 ✅+hash)

> 量級:S=半天內、M=1-3 天、L=1-2 週、XL=3 週+(以 AI 執行速度計)。
> 格式:ID|項目|內容與驗收標準|量|依賴

### WS-D 偵測與模型(Detection)

| ID | 項目 | 內容與驗收 | 量 | 依賴 |
|---|---|---|---|---|
| D01 | 實機延遲遙測 | DebugPanel 數據(delegate/ms/fps/light)加一鍵「複製診斷」;使用者回報後決定 perfMode 預設。驗收:三台機型的 416/640 實測 ms 表 | S | 使用者實測 |
| D02 | perfMode 預設再評估 | 若 416 快且準 → 預設 'speed',或 Quality 也改吃 416 模型;persist migration | S | D01 |
| D03 | raw-head 匯出 kernel | 訓練 kernel 加第二匯出:decode 前的 raw head(grid/stride 外移)。驗收:onnx 兩顆(decoded+raw)數值一致性腳本過 | M | — |
| D04 | worklet decode | yoloParser 支援 raw-head(grid+exp 在 TS/worklet 做);與 decoded 版輸出逐位元對齊測試 | M | D03 |
| D05 | full int8 量化 | raw-head 版 full-int8(校準集用真實影格);validate_model.py 對比 float32 不掉 >2 分。**先前失敗根因=decode 摺疊後動態範圍爆炸,raw-head 解決** | M | D04 |
| D06 | int8 上線 | 換 asset;實測 ms 應 ~2-3×快;fps 提升迴歸整條追蹤(彗尾斷點應顯著減少) | S | D05 |
| D07 | eval set v1 | 從飛輪+使用者影片建 per-condition 標註集(室內/戶外/無網/暗光/近framing/遠framing 各 ≥200 球);格式:videoPath+windows+ground truth | L | 飛輪資料 |
| D08 | replay harness | 離線批量:eval set → recheck 引擎全速重放 → 混淆矩陣/per-condition 準度。驗收:一鍵出報告,CI 可跑 | M | D07 |
| D09 | depthVeto 轉正 | harness 上跑 veto ON/OFF 對比;假進球↓且真進球不掉 → 預設 ON | S | D08 |
| D10 | reappearance 轉正 | 同上流程;unsure→make 升級正確率 >95% → 預設 ON | S | D08 |
| D11 | viewBand routing 轉正 | 高視角/低視角不同融合權重;harness 驗證後開 | M | D08 |
| D12 | 橢圓框面測試 | rim 橢圓長短軸→視角→過框改橢圓內點測試(取代 1D span);高視角 case 準度 +5 分以上才收 | L | D08 |
| D13 | 飛輪重訓 R1 | 難例 ≥2k → 併入訓練集重訓 Tiny → validate 過 → 換 asset;建立「重訓 SOP」文件 | L | 飛輪 ≥2k |
| D14 | 時序第四訊號(研究) | tracklet 序列 → 微型 temporal 模型(TCN/tiny transformer)make/miss 二分類;離線 AUC >0.9 才考慮上 | XL | D07 |
| D15 | 多球場景 | tracklet 關聯:同幀多球時依連續性分軌;熱身多球不誤 arm。驗收:多球測試影片 0 假 attempt | L | — | ◐ v1 guard 上線 2026-07-10(suppression-only armLockout,吃 per-model cold gate;tracklet 分軌+影片驗收待做) |
| D16 | 多人歸屬 | 出手球員歸屬(release-pose + lastHolder);per-player session 統計。驗收:2v2 影片歸屬正確 >85% | XL | D15 |
| D17 | EfficientDet 備援收尾 | 查 Lightning 訓練→下載→寫 parser→validate 對比;贏才換,輸則存檔當保險 | M | 訓練完成 |
| D18 | 模型無關驗證 | 文件化「換底層模型 checklist」;用 D17 或任一新模型走完一輪證明架構可換芯 | S | D17 |
| D19 | 鏡頭髒污/眩光偵測 | 開場自檢:模糊度/眩光 heuristic → 提示擦鏡頭。誤報率 <5% | M | — | ◐ 上線 2026-07-10(lensCheck advisory chip+debug 列;誤報率待實機統計) |
| D20 | 自動 re-lock 強化 | 相機被踢後免手動:drift 期間持續嘗試以舊 rim 特徵重鎖,10 秒內自動恢復率 >80% | M | — | ◐ v1 上線 2026-07-10(settle-boost 快速重心 + drift 期 arm 鎖;恢復率待實機量) |
| D21 | 錄影害羞模式 | 只存統計不存影片時,仍保留 unsure 球 ±5 秒 ring buffer 供重判(隱私+準度兼得) | M | — |
| D22 | 熱節流自適應 | ProcessInfo.thermalState(iOS)/Android 等效 → 分級降幀策略,1 小時 session 不崩;記錄降級事件遙測 | M | D01 | ◐ v1 上線 2026-07-10(推論延遲代理版 thermalGovernor L0-L3 分級降幀+ROI/pose shedding;ProcessInfo 原生訊號待接) |
| D23 | 夜間紅外/極暗實驗 | 極暗場地實測:光 profile 'dark' 下的實際準度;必要時訓練集加暗光增強重訓 | M | D13 |
| D24 | 準度頁 v2(自動化) | 每 release CI 跑 harness → 產出 per-condition 準度 JSON → app 內「Accuracy」頁+官網頁自動更新 | M | D08 |

### WS-P 產品功能(Product)

| ID | 項目 | 內容與驗收 | 量 | 依賴 |
|---|---|---|---|---|
| P01 | AR drill 模式 v1 | HomeCourt 式:5 個定點投籃 drill(角落三分/罰球/中距離…),畫面綠點目標+大字 rep 計數+語音;drill 結果進 db | L | — |
| P02 | drill 編輯器 | 自訂 drill:點位/目標數/時限;可存可分享(JSON) | M | P01 |
| P03 | 教練建議引擎 v1 | Shot Lab 數據 → 規則式建議(入射角低→弧度建議;release 慢→出手速度 drill);每週報告卡 | L | — |
| P04 | 週報/月報 | 每週一張「本週你的投籃」統計卡(趨勢/最佳時段/區域熱圖),可分享 | M | — |
| P05 | 投籃區域熱圖 v2 | 半場圖 per-zone FG%,含 2/3 區分與時間篩選 | M | — |
| P06 | 影片標註播放器 | 回放時疊軌跡+過框點+訊號時間軸(收據的影片版);逐幀步進 | L | — |
| P07 | Session 目標 | 開場設目標(50 進球/30 分鐘/FG50%),live HUD 顯示進度,達成慶祝 | S | — |
| P08 | 中斷恢復 | app 被殺後重開能恢復未結束 session(db 已有資料,補 UI 流程) | M | — |
| P09 | HORSE 遠端版 | 兩台手機輪流出題(拍投籃→對方同點重現),回合制經由分享連結 | XL | G03 |
| P10 | 裁判輔助研究 | pose 時序:走步/兩運 heuristics 離線研究;可行性報告決定是否產品化 | XL | D14 |
| P11 | 兒童/矮框模式 | rim 高度設定(2.6m/3.05m)進 courtGeometric;小朋友場景驗證 | S | — |
| P12 | 無障礙全查 | VoiceOver/TalkBack 全流程走查;動態字級;色盲(已有 shape+color 原則)全面驗證 | M | — |
| P13 | iPad/平板佈局 | 大屏雙欄佈局(live 左畫面右統計);教練場景 | M | — |
| P14 | 多語言 v1 | i18n 架構 + 繁中/英文雙語(字串抽離~600 條);語音報分也雙語 | L | — |
| P15 | Onboarding v2 | 互動式:第一次開相機時用 demo 影片讓使用者「假裝投一球」看到偵測,再進真場地 | M | — |
| P16 | 深色/淺色主題? | **不做**——broadcast 深色是品牌;此行留著防止未來 AI 提案 | — | — |
| P17 | Widget/桌面小組件 | iOS WidgetKit:今日進球/連續天數;點擊直達 quick start | M | 上架後 |
| P18 | 每日提醒 | 本地通知:練球提醒+每日挑戰預告(可關);尊重系統勿擾 | S | — |
| P19 | 資料匯出/匯入 | 全資料 JSON+CSV 匯出、跨機匯入(免帳號的「備份」方案) | M | — |
| P20 | Shot Lab v2 | 原型庫 12→24 位球星;動作相似度演算法用時序 DTW 取代單幀;歷史趨勢對比 | L | D14 部分 |

### WS-G 成長與社群(Growth)

| ID | 項目 | 內容與驗收 | 量 | 依賴 |
|---|---|---|---|---|
| G01 | ASO 套件 | 雙商店關鍵字研究、名稱副標、5 語系截圖(用真 UI 生成)、預覽影片腳本 | M | 上架 |
| G02 | 浮水印 reels 優化 | 分享卡+Reel 的品牌 hook A/B(掃碼角標 vs 文字);錄屏引導提示 | S | — |
| G03 | Ghost 跨裝置 | ghost timeline 匯出成極小檔(<5KB)→ 連結/QR 分享 → 對方 app 開啟即對戰;無後端(檔案即協議) | L | — |
| G04 | 誠實排行榜 v1 | 僅收「偵測計分+有錄影」成績;先用 serverless(CF Workers+KV,月費~0);週榜/挑戰榜;防作弊=抽查 reel | XL | G03 |
| G05 | 挑戰賽引擎 | 週主題挑戰(罰球王/三分雨)配排行榜+限定徽章;營運月曆模板 | M | G04 |
| G06 | 推薦迴路 | 「邀請朋友 ghost 對戰」流程;雙方各得限定徽章 | M | G03 |
| G07 | 創作者包 | 給籃球 YouTuber/IGer 的 media kit:app 亮點+素材+聯絡模板;列 20 個目標創作者(華語+英語) | M | 上架 |
| G08 | IG 深度整合 | react-native-share Stories API+Meta App ID:一鍵貼限動附貼紙回連 | M | Meta App ID |
| G09 | 官網 v1 | 一頁式:demo 影片+準度頁(D24 資料)+下載連結;Cloudflare Pages | M | D24 |
| G10 | 社群陣地 | Discord 或 subreddit 擇一深耕;bug 回報+挑戰賽公告+難例徵集 | S | — |
| G11 | 學校/球隊試點 | 3 支真實球隊免費試用教練面板換回饋+見證;台灣在地開始 | L | B04 |
| G12 | UGC 難例徵集活動 | 「拍倒 AI」活動:上傳 AI 判錯的球(=飛輪資料),月選最刁鑽送徽章 | S | 飛輪 |

### WS-B 商業化(Business)

| ID | 項目 | 內容與驗收 | 量 | 依賴 |
|---|---|---|---|---|
| B01 | IAP 基建 | RevenueCat(或 expo-iap)接入;premium.ts entitlements 接線;恢復購買;沙盒全流程測試 | L | 上架 |
| B02 | Pro v1 | $4.99/月 或 $29.99 買斷(同時上,A/B 定價頁):無限重判、進階 Shot Lab、無浮水印卡、全部匯出 | M | B01 |
| B03 | 付費牆設計 | 軟牆:免費功能永遠可用;Pro 點在價值峰值時機出現(重判完成時/週報生成時);絕不擋核心追蹤 | M | B02 |
| B04 | 教練面板 v1 | 多球員彙整(先單機:教練手機收 ghost/報告檔)、drill 指派、隊報表;$19/月/隊 | XL | G03 |
| B05 | 單位經濟表 | 成本(~$0 邊際+商店抽成)/轉換/LTV 試算表;每季更新真實數字 | S | B02 |
| B06 | 定價實驗 | 三檔測試(4.99/6.99/2.99 首月);地區定價(台灣/美國) | M | B02 |
| B07 | 退款與客服 SOP | 模板+FAQ 頁;App 內回報通道(帶診斷資訊) | S | 上架 |
| B08 | 法務基線 | 隱私政策(強調不離機)、服務條款、開源授權清單頁(Apache/CC-BY 名單);**收費版移除 AGPL YOLO11** | M | 上架前 |
| B09 | 贊助挑戰賽提案書 | 用戶量 >10k 後:給球具/飲料品牌的冠名提案模板 | S | G05+量 |
| B10 | B2B 通路 | 籃球訓練營/球館合作方案(場地海報 QR+分潤);2 家試點 | L | B04 |

### WS-Q 品質與基礎設施(Quality/Infra)

| ID | 項目 | 內容與驗收 | 量 | 依賴 |
|---|---|---|---|---|
| Q01 | CI 全量回歸 | GitHub Actions:tsc+jest+harness(D08)每 PR;模型檔 LFS 或 release 資產化(repo 已 60MB+ 模型,評估瘦身) | M | D08 |
| Q02 | E2E 冒煙 | Maestro/Detox 擇一:安裝→onboarding→demo 模式跑完一 session→summary 的自動化冒煙 | L | — |
| Q03 | 崩潰/效能遙測 | Sentry(self-host 或免費層):crash+ANR+關鍵 span(冷啟/鎖框時間);隱私政策同步 | M | B08 |
| Q04 | 錯誤預算制 | crash-free ≥99.5%;跌破時凍結功能開發只修穩定性(寫進本檔節奏) | S | Q03 |
| Q05 | DB 壓力測試 | 1000 session/50k 球的效能測試;必要的索引與分頁(History/Trends 已有部分) | M | — |
| Q06 | 儲存管理 | 影片空間管理頁:總量/逐場清理/自動清理策略(保留 clips 刪全片) | M | — |
| Q07 | 升級遷移測試 | 每 release 前:從上一版真實資料庫升級的自動測試(schema+persist stores) | M | Q01 |
| Q08 | 安全審查 | 匯出檔不含敏感路徑;深連結驗證;依賴 audit 每季 | S | — |
| Q09 | 效能預算 | 冷啟 <2.5s、鎖框 <4s、HUD 60fps;預算寫進 CI(可測項)與手測清單 | M | Q03 |
| Q10 | 文件債 | ARCHITECTURE.md 更新到現況(三波後已過時);新人(AI)上手路徑=本檔→ARCHITECTURE→模組 docblock | M | — |

### WS-F 資料飛輪與 MLOps(Flywheel)

| ID | 項目 | 內容與驗收 | 量 | 依賴 |
|---|---|---|---|---|
| F01 | 飛輪桌面端 | 收 manifest → 自動從影片切難例 clip → 標註工具(簡單網頁,localhost)→ 訓練格式輸出 | L | — |
| F02 | 半自動標註 | 現役模型預標 → 人只修錯;每球標註時間 <10 秒 | M | F01 |
| F03 | 資料版本管理 | 資料集版本化(DVC 或簡單 manifest+hash);每次重訓可溯源 | M | F01 |
| F04 | 重訓 SOP 文件化 | 從難例到上線 asset 的完整腳本化流程(kernel 參數/驗證門檻/回滾法);任何 AI session 可獨立執行 | M | D13 |
| F05 | 季度重訓節奏 | 每季一輪(或難例 +2k 觸發);訓練平台輪替策略(Kaggle 額度/Colab/Lightning) | 常態 | F04 |
| F06 | 遙測→訓練閉環 | (選配同意)匿名 per-condition 準度統計回傳 → 弱項場景優先蒐料 | L | Q03+B08 |
| F07 | 眾包 eval 網 | 邀 10-20 位活躍用戶成「準度陪審團」:每月標 50 球換 Pro;eval set 持續長大 | M | G10 |

### WS-X 平台擴張(Q4 實驗性)

| ID | 項目 | 內容與驗收 | 量 | 依賴 |
|---|---|---|---|---|
| X01 | Apple Watch 伴侶 | 心率疊加到 session 統計;離手也能看比分震動 | L | 上架 |
| X02 | 雙機位實驗 | 第二支手機側翼視角,BLE/本地網路同步時戳;深度歧義(麵包球)物理性解決的研究原型 | XL | — |
| X03 | 直播 overlay | RTMP/OBS 比分疊層(球館/賽事用);先做 HDMI 截圖版 MVP | XL | B10 |
| X04 | TV/投影模式 | AirPlay/Chromecast 即時比分大屏 | M | — |

---

## §5 精準度階梯(擴充版)

**誠實天花板(單鏡頭)**:飛行幀 50-60%、側面判定 90-93%、任意擺放 80-85%、2/3 校準後 ~90%。

**逼近順序與量化目標**:
1. **int8+raw-head(D03-D06)**:fps 15→30 = 軌跡採樣翻倍 → geo 過框可靠度直接受益。目標:斷軌率(>0.3s 無真實樣本的比例)砍半。
2. **飛輪重訓(D13/F0x)**:每輪目標 — 難例集上的球偵測 recall +10 分;eval set 總準度 +2 分。
3. **flag 轉正(D09-D11)**:每個 flag 用 harness 出 ON/OFF 對照表,寫進準度頁 changelog。
4. **橢圓框面(D12)**:高視角(俯角 >25°)子集準度 +5 分。
5. **時序訊號(D14)**:離線 AUC >0.9 才進 app;進 app 後 unsure 率目標 <5%。
6. **每季準度頁更新**:數字沒進步的一季 = 檢討會(寫進本檔 §9)。

**低 fps 硬化(iPhone XR 8–15fps)**:決策核心的所有「N 幀」門檻已改為以量測到的取樣間隔換算的時間視窗(30fps 逐位元不變),各裝置階層 × 場景的判定路徑與驗證狀態見 [docs/DEVICE-SCENARIO-MATRIX.md](DEVICE-SCENARIO-MATRIX.md)。

**實驗紀律**:任何準度改動 → harness before/after → 貼數字進 commit message。沒有數字的準度 PR 不收。

---

## §6 商業化(擴充版)

**定位一句話**:「每一球都有收據的免費追蹤器」— Android 真空 + 誠實 + 零摩擦。

**定價架構**:
| 層 | 內容 | 價格 |
|---|---|---|
| Free(永久) | 即時追蹤、基本統計、遊戲模式、分享卡(浮水印)、每場 3 球重判 | $0 |
| Pro 月訂 | 無限重判、進階 Shot Lab+週報、無浮水印、全匯出、雲備份(選) | $4.99/月(首月 $2.99 實驗) |
| Pro 買斷 | 同上永久 | $29.99 |
| Team | 教練面板+drill 指派+隊報表 | $19/月/隊 起 |

**上市 playbook(Q1)**:TestFlight 100 人公測(G10 社群徵)→ 修一輪 → 雙店同步上 → 創作者包發 20 家(G07)→ Product Hunt/相關 subreddit → 準度頁當差異化主打。

**北極星指標**:每週「被計分的球數」(WSS, weekly scored shots)。所有功能決策問:這會讓 WSS 漲嗎?

**授權紅線**:收費版本體只含 Apache/MIT/CC-BY 資產;AGPL YOLO11 在 B02 前移除;`docs/` 維護授權清單(B08)。

---

## §7 護城河(擴充版)

| 護城河 | 為什麼難抄 | 年度維護動作 |
|---|---|---|
| 誠實可驗證 | 收據+公開分場景準度;訂閱大廠不敢公佈錯誤率 | D24 自動化;每 release 更新 |
| 真實球場容錯 | 無網/無線/暗光/任意角;競品架構鎖死(要地線/好網/雲端) | 爛場地 bug 一律 P1 |
| 資料飛輪 | 專屬難例集只會越滾越大;後進者沒有 | F01-F07 全線 |
| 確定性可重放核心 | 純 TS+camera-clock → 重判/回歸/收據近乎免費;抄襲需整個重構 | 核心改動保持純函式+測試 |
| Android 真空先佔 | HomeCourt 棄置、Ball AI 排隊中;ghost/排行網路效應 | Q1 上架、G03/G04 |
| 迭代速度 | 多 agent 波次工作流,一天三波;人力團隊追不上 | 鐵律 7/9 紀律 |
| 模型無關架構 | 底層模型可整顆換(D18 驗證);大廠開源更強模型=我們免費升級 | 每次換芯走 checklist |

**被取代情境對沖**:
- Apple/Google 內建基礎追蹤 → 深耕教練 B2B、社群資料、跨平台(平台商不做的)
- HomeCourt 復活/大廠入場 → 速度+免費+Android+準度頁正面剛
- 泛用 VLM 直接看影片計分 → 成本/延遲/離線是我們的場;且 VLM 可作為我們的離線重判升級選項(拿來用而非被取代)

---

## §8 KPI 儀表(季度目標)

| 指標 | Q1 | Q2 | Q3 | Q4 |
|---|---|---|---|---|
| WSS(週計分球數) | 基線建立 | 5 萬 | 20 萬 | 50 萬 |
| MAU | 500 | 3k | 10k | 25k |
| 週留存 | — | 15% | 20% | 25% |
| 側面判定準度(公開) | 88% | 90% | 92% | 92%+ |
| unsure 率 | <12% | <10% | <8% | <8%(重判後<4%) |
| crash-free | 99% | 99.5% | 99.5% | 99.7% |
| Pro 轉換 | — | 實驗 | 2% | 3% |
| 付費球隊 | 0 | 0 | 3 | 10 |
| 難例集 | 1k | 3k | 6k | 10k |

---

## §9 風險登記簿

| 風險 | 機率 | 衝擊 | 對策 |
|---|---|---|---|
| Tiny 模型實機太慢 | 中 | 高 | D01 即測;D02 換 416 預設;D05 int8 是根治 |
| Apple 審核卡(相機用途/未成年) | 中 | 高 | 審核指南預檢;隱私文案強調不離機;B08 先行 |
| 準度公開反噬(數字不夠漂亮) | 低 | 中 | 誠實是定位:公佈+改進曲線比藏拙可信 |
| 訓練平台額度斷炊 | 中 | 中 | Kaggle/Colab/Lightning 三線輪替(F05);RunPod ~$3/輪付費保底 |
| 單一開發者(bus factor) | 高 | 高 | 本檔+F04 SOP+全測試=任何 AI session 可接手,這正是本檔存在的原因 |
| 社群功能引來作弊 | 中 | 中 | 誠實榜=需錄影抽查;reel 驗證;寧可榜小而真 |
| 免帳號 vs 雲功能矛盾 | 低 | 中 | 帳號永遠是 Pro 的「選配」,核心離線;P19 匯出當免帳號備份 |
| 資料庫/影片塞爆手機 | 中 | 中 | Q06 儲存管理;預設保留策略 |

---

## §10 已定案決策(不要重新辯論)

1. 出手判定**球優先**,YOLO person 不當 arm 條件(僅 origin 註記)
2. letterbox 黑邊剔除三入口強制
3. 罰球線校正=**選配**,永不強制;校正成功即生效
4. 佐證器原則:只升級 null、需 net/cls 同意、偏靶不定罪
5. YOLOX(Apache)為預設引擎;AGPL 不進收費版
6. 模型更換流程:雲訓練→本機轉檔→validate 實測→過門檻才換
7. **免帳號、影片不離機**是產品承諾
8. UI=深色 broadcast,tokens.ts 唯一色源;**不做淺色主題**(P16)
9. worktree 多 agent 流程+合併後 4-lens 審查為標準作業
10. 北極星=WSS;護城河優先序=誠實>資料>速度
11. 排行榜只收偵測計分成績(誠實榜),寧小而真
12. Pro 付費牆絕不擋核心追蹤功能

---

## §11 執行方法(給 AI 的作業系統)

- **波次模式**:大批工作=worktree agent 波(互斥檔案所有權)→ 合併 → 4-lens 整合審查 workflow → 修 → release。單項工作直接做。
- **每次 session 開場**:讀本檔 §0/§1 → `git log --oneline -10` → 任務板/§4 找下一個未 ✅ 的 ID。
- **每完成一個 ID**:在 §4 該行標 `✅ <hash>`;若做法偏離內容欄,一行說明。
- **每月**:更新 §1 快照+§8 實際數字;每季:檢討 §3 出口條件,必要時調整後續季度。
- **新知識**:事故教訓進 §0 鐵律;方向決策進 §10;都要 commit。
- **本檔衝突時**:§10 決策 > 使用者當下指示?否——**使用者永遠最大**,但要先提醒他該決策存在再執行變更,並更新本檔。
