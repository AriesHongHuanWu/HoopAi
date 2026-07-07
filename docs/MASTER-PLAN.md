# HOOPILOT 主計畫(Master Plan)

> **這份文件的用途**:給未來的 AI session 和開發者的完整接手檔 + 從現在到「最完成體」的路線圖。
> 讀完這份你應該知道:現在在哪、要去哪、怎麼去、什麼不要再重新討論。
> 最後更新:2026-07-08(commit `d6a1690`)。改動重大方向時必須更新本檔。

---

## 0. AI 接手須知(先讀這段)

**專案**:Hoopilot — 手機單鏡頭即時籃球投籃追蹤 app(iOS+Android),完全 on-device,免帳號免訂閱。
Repo:`AriesHongHuanWu/HoopAi`,本機 `C:\Users\aries\claude\claudeCode\hoop-ai`。

**指令**:
- 驗證:`npx tsc --noEmit && npx jest`(目前 629 tests,必須全綠才能 commit)
- iOS IPA:`gh workflow run ios-ipa.yml`(~16 分,自動發到 `ios-ipa-latest` release)
- Android APK:push main 自動建(~37 分,`android-latest` release)
- 模型驗證:`python tools/validate_model.py --model X.tflite --video <真實影片> --fps 6 --size 416|640 --compare <現役asset>`(**任何模型更換前必跑,val 分數會騙人,實測影片不會**)

**鐵律(違反過都出過事)**:
1. 不在使用者本機訓練模型(GPU 過熱)— 訓練上 Kaggle/Colab/Lightning;本機只做轉檔(CPU 幾分鐘 OK)
2. 程式碼與註解全英文;commit 結尾 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
3. 絕不代打使用者的帳號密碼/金鑰;Kaggle kernel 檔案純 ASCII;kaggle CLI 要 `PYTHONUTF8=1`
4. ROI 二次偵測只能貢獻 `ball` 類,絕不注入 `ball_in_basket`(會鑄造假進球)
5. 任何「佐證器」(virtual crossing / reappearance)只能升級 `geo null→true` 且必須有 net/cls 同意;絕不單獨定案、絕不翻轉已判定的球
6. 換模型前必過 `validate_model.py` 實測影片對比(curated-Tiny 事件:val 0.922 但實測更爛)
7. Worktree 並行開發:agent 不得動 `ui.tsx`/`tokens.ts`;**刪 worktree 前先檢查 node_modules junction(`Get-Item -Force` 看 LinkType,先 `.Delete()` 解鏈)**,否則會刪穿主 repo 的 node_modules
8. `AGENTS.md`:寫碼前讀 Expo v57 版本文件

**關鍵檔案地圖**:
| 層 | 檔案 |
|---|---|
| 偵測核心(純 TS、可重放) | `src/core/shotFsm.ts`(三訊號融合+4條arm路徑)、`ballTracker.ts`(Kalman)、`rimLock.ts`、`trajectory.ts`、`recheck.ts`(離線重判) |
| 佐證/深度 | `reappearance.ts`、`depthRatioGate.ts`、`courtGeometric.ts`(metric 2/3)、`ftCalibration.ts`、`lightProfile.ts`、`placementGrade.ts` |
| 相機/ML | `src/camera/useShotEngine.ts`(worklet 熱路徑)、`src/ml/yoloParser.ts`、`letterboxCull.ts`、`roiTransform.ts` |
| 資料 | `src/data/db.ts`(SQLite,schema v6)、`hardExamples.ts`(訓練飛輪匯出) |
| 訓練 | `training/yolox/`(權重+配方)、`tools/validate_model.py`、`tools/quantize_tflite.py` |
| 研究存檔 | `docs/research/competitors-2026-07.md`(競品全分析+build list) |

---

## 1. 現況快照(2026-07-08)

**偵測管線**:YOLOX-Tiny 小球特化模型(416 Speed / 640 Quality)→ worklet 解析+letterbox 剔除 → Kalman 追蹤(飛行放寬 0.12、暗光冷啟動 0.16)→ ShotFsm 三訊號融合(geo 幾何過框 / net 網動 / cls 入框類別),4 條 arm 路徑(jump 上升、layup 球在框邊、descend 拋物線落入、release pose 出手),佐證器(virtual crossing、reappearance)、防護(pass-through guard、卡球抑制、putback window、雙計冷卻)。

**實測數字(296 幀真實影片)**:
| 指標 | 舊 nano | 現役 small-ball Tiny |
|---|---|---|
| 球冷啟動偵測 @416 | 3.4% | **61.5%** |
| 球追蹤帶 @416 | 6.4% | **72.0%** |
| 球冷啟動 @640 | 9.5% | 38.6% |
| 籃框 @416 | 56.4% | 63.2% |

**已上線功能**(3 波 19 agent + 早期工作):即時 HUD+軌跡彗尾+落點預測、錄影+自動剪輯、每球證據收據(geo/net/cls chips)+滑動改判+Undo、離線重判 unsure、8 個遊戲模式(含 Ghost Challenge 跟自己賽跑)、每日挑戰+積分、成就 26 徽章、Shot Lab(NBA 12 球星原型對照+雷達+骨架)、IG 分享卡(feed/story/twin)+一鍵精華 Reel+浮水印、語音報分+連勝播報、罰球線校正(選配)、幽靈籃框擺位引導、BootIntro 開場、暗光模式、訓練資料飛輪匯出。

**未完成/等待中**:
- EfficientDet-Lite 訓練(Lightning.ai,乾淨授權備援)— 狀態要查 [[effdet-training-run]]
- 實機延遲未測:Tiny 比 nano 大 5 倍,**若 Quality 模式太慢 → 把預設 perfMode 改 'speed'(416 實測反而更準)**
- IG Stories 深度整合(要使用者的 Meta App ID)
- 正式上架(EAS/TestFlight/$99 開發者帳號)

---

## 2. 最完成體 — 功能藍圖

### Phase A:上架就緒(1-2 週等級)
| 功能 | 說明 | 價值 |
|---|---|---|
| 正式命名/icon/截圖 | App Store 資產、ASO 關鍵字 | 曝光 |
| TestFlight → App Store + Play Store | 需 $99 Apple 開發者帳號;EAS workflow 已存在(ios-eas.yml) | 分發根基 |
| 公開準度頁 | 用 replay harness 跑 500+ 球、分場景(室內/戶外/無網/暗光)公佈數字,每版更新 | **信任護城河啟動** |
| Crash/analytics(隱私友善) | Sentry self-host 或 expo 內建;絕不上傳影片 | 品質迴圈 |

### Phase B:偵測完全體(核心技術,1-3 個月)
| 功能 | 說明 | 依賴 |
|---|---|---|
| int8 量化 + raw-head 匯出 | P2 路線:raw head + worklet decode → full int8,640 推理 77ms→~27ms | 訓練 kernel 改匯出頭 |
| 更高幀率追蹤 | int8 省下的時間 → 30fps 偵測 → 軌跡幾乎不斷 | 上一項 |
| 深度 veto / reappearance 轉正 | 現在 flag OFF;用資料飛輪蒐集的標註球驗證後翻開 | 500+ 標註球 |
| 多球/多人場景 | tracklet 關聯(誰投的哪顆)、per-player 統計 | 追蹤重構 |
| 訓練 drill 模式(AR 目標) | HomeCourt 式:畫面上綠點目標、reps 計數、語音教練 | pose 已有 |
| 完整投籃教練 | release/arc/leg 數據 → 具體建議(Shot Lab 已有骨架)+ 每週改善報告 | 資料累積 |
| 裁判輔助(moonshot) | pose 走步/兩運偵測 — 研究性質,能做到就是全球第一 | pose 時序模型 |

### Phase C:社群與成長(與 B 並行)
| 功能 | 說明 |
|---|---|
| Ghost 分享 | 把自己的 ghost timeline 傳給朋友 → 異地同框對戰(檔案極小,無需後端即可用連結/QR 分享) |
| 排行榜(誠實版) | 只收「有錄影+偵測計分」的成績 — 對比 Level Up 的自報制;初期可用 GitHub Gist/簡單 serverless |
| 教練/球隊面板 | 多球員 session 彙整、指派 drill、進度追蹤 — **B2B 收費核心** |
| IG Stories 深度整合 | react-native-share + Meta App ID → 一鍵貼限動附回連 |
| 挑戰賽/活動 | 週主題挑戰(如「本週罰球王」),贊助商冠名空間 |

### Phase D:平台擴張(6 個月+)
Apple Watch 心率疊加、雙機位(第二支手機當側翼視角,BLE 同步)、直播比分 overlay(OBS/RTMP)、學校/球館 kiosk 模式。

---

## 3. 精準度階梯(怎麼更準)

**誠實天花板(單鏡頭物理極限)**:飛行幀偵測 50-60%、側面架設進球判定 90-93%、任意擺放 80-85%、2/3 分校準後 ~90%。逼近天花板的順序:

1. **資料飛輪(最高複利)**:hardExamples 匯出 → 使用者改判/unsure 的片段就是模型最需要的訓練樣本 → 每次重訓都針對真實失敗案例。同時累積出 per-condition eval set(公開準度頁的數據源)。
2. **速度→準度轉換**:int8 + raw-head(P2)讓偵測 fps 翻倍 — 更多幀 = 追蹤更連續 = geo 過框更可靠。**這是目前 CP 值最高的技術投資。**
3. **flag 轉正驗證**:depthVeto(麵包球視差)、reappearance、useViewBandRouting 都已寫好測好但 OFF — 用飛輪資料跑 benchmark,逐個翻開。
4. **橢圓框面測試(P0 殘項)**:rim 的橢圓長短軸比 → 視角角度 → 過框判定用橢圓內點測試取代 1D span,高視角時大幅提升。
5. **時序小模型(研究)**:tracklet(位置序列)餵一個微型 temporal 網路做 make/miss 二分類,當第四訊號 — 訓練資料直接來自飛輪。
6. **每機型 profile**:蒐集 inference ms / fps 遙測 → 自動選最佳模型+輸入尺寸(現在的 auto 是粗糙版)。
7. **416 vs 640 再評估**:實測 416 較準且較快 — 拿到實機數據後可能把 Quality 也改吃 416 模型(或乾脆單一模型)。

---

## 4. 商業價值(怎麼賺錢)

**定位**:「每一球都有收據的免費追蹤器」— 對比 HomeCourt(iOS-only、半棄置)、Ball AI(要 Apple Watch、訂閱牆、人工標註後台)、ShotBot(要亮光好網、帳號)。我們吃 **Android 真空 + 誠實 + 零摩擦**。

**授權前提(已解決)**:預設模型 YOLOX=Apache-2.0、資料 CC BY 4.0、MoveNet Apache — **可商用**。YOLO11(AGPL)只能留作非預設 fallback,收費版考慮直接移除。

| 收入線 | 內容 | 定價感 | 前置 |
|---|---|---|---|
| **Pro 訂閱(主線)** | 無限離線重判、進階 Shot Lab(趨勢/對比報告)、無浮水印分享卡(`premium.ts` 已有 entitlement 骨架)、無限雲備份 | $4.99/月(壓在 HomeCourt $8 之下) | 上架+IAP |
| **教練/球隊 B2B** | 多球員面板、drill 指派、隊內排行、匯出報告 | $15-30/月/隊 | Phase C 面板 |
| **一次性買斷選項** | ShotBot 模式:$29.99 終身 — 對訂閱疲勞族群 | 與訂閱並行 A/B | IAP |
| 挑戰賽贊助 | 品牌冠名週挑戰(球具/飲料商) | 後期 | 用戶量 |
| 資料資產 | 全球最大「手機視角投籃失敗案例」標註集 — 不賣個資,但支撐模型優勢與潛在授權 | — | 飛輪運轉 |

**免費層永遠保留**:即時追蹤+基本統計+分享卡(帶浮水印)— 免費用戶就是行銷管道(浮水印 reels)與資料飛輪來源。**免帳號承諾不變**(Pro 可選帳號做雲備份)。

---

## 5. 護城河(避免被取代)

| 護城河 | 為什麼難抄 | 維護動作 |
|---|---|---|
| **誠實可驗證(shows its work)** | 每球證據收據+公開分場景準度數字。訂閱大廠不敢公佈錯誤率,硬體廠做不出視覺證據 | 每版更新準度頁;收據 UI 持續深化 |
| **真實球場容錯** | 無網/無地線/暗光/任意角度都能用 — 競品架構上被鎖死(要地線校準、要好網、要雲端) | 每個「爛場地」bug 都當 P1 修 |
| **資料飛輪** | 使用者改判 → 專屬難例集 → 模型只會越來越貼真實使用場景;後進者沒有這批資料 | 重訓節奏:每累積 ~2k 難例跑一輪 |
| **確定性可重放核心** | 純 TS、camera-clock、無 wall-clock — 離線重判/回歸測試/收據都因此近乎免費;抄襲者得整個架構重來 | 任何核心改動保持純函式+測試 |
| **Android 真空 + 免費** | HomeCourt iOS-only 且棄置;Ball AI Android 排隊中 — 先佔者網路效應(ghost 對戰、排行) | 加速 Play Store 上架 |
| **迭代速度** | 本檔+worktree 多 agent 工作流 = 一天三波升級;人力團隊追不上 | 保持 629+ 測試全綠的紀律 |
| **獨特技術棧文件化** | 三訊號融合+四路 arm+佐證器組合是逐步實戰演化的,參數背後全是真實失敗案例 | 決策記錄(§6)持續補充 |

**風險與對沖**:Apple/Google 平台級內建(→深耕教練 B2B 與社群資料,平台不會做);HomeCourt 復活(→速度+Android+免費);大廠開源萬能偵測模型(→我們的價值在管線與資料,模型可以直接換上更強的 — 模型無關架構是特性不是弱點)。

---

## 6. 已定案決策(未來 AI 不要重新辯論)

1. **出手判定球優先**,不用 YOLO person 當 arm 條件(person 只做 origin 註記)— 2026-07-07 定案,理由:person 偵測雙向不可靠+黑邊幻覺。
2. **letterbox 黑邊剔除**在三個入口(主偵測/ROI/靜態圖)強制執行。
3. **罰球線校正=選配加值**,永不強制 — 籃框 0.45m 就是預設的尺;校正成功即生效(不再綁 metric23 flag)。
4. **佐證器原則**:virtual crossing / reappearance 只升級 null、需 net/cls 同意、投影偏靶不定罪。
5. **YOLOX(Apache)是預設引擎**;AGPL 的 YOLO11 不得成為收費版預設。
6. **模型更換流程**:訓練(雲)→ 本機轉檔 → `validate_model.py` 實測影片對比 → 過了才換 asset。
7. **免帳號、影片不離機**是產品承諾,不是暫時狀態。
8. **UI 系統**:深色 broadcast(coal/#F05A24 leather/Barlow Condensed),tokens.ts 是唯一色源;多 agent 並行時 ui.tsx/tokens.ts 唯讀。
9. **worktree 多 agent 開發流程**:互斥檔案所有權+各自跑 tsc/jest+合併後必跑整合審查 workflow(4-lens)— 15 agent 兩波抓出 16 個整合 bug 證明審查不可省。

---

## 7. 下一步佇列(依序執行)

1. 實機測試 small-ball 模型(使用者回報延遲/體感)→ 決定 perfMode 預設
2. 查 Lightning.ai EfficientDet 訓練狀態(備援模型)
3. Phase A 上架四件套
4. int8 + raw-head 匯出(P2)
5. 飛輪第一輪:等使用者累積難例 → 匯出 → 重訓
