# Hoopilot 實機 Smoke Checklist(每次大版本必跑)

> **為什麼有這份文件**:開發全在 Windows 上進行,相機管線(VisionCamera + 偵測模型)在開發機上
> **完全跑不起來** — 單元測試再綠也驗不到「真的鏡頭、真的球、真的籃框」。這份清單就是那個缺口的
> **強制替代品**:每一次 mega-upgrade build 出來之後、release 之前,必須由真人拿實機把下面每一節
> 跑完一遍。沒跑完 = 不能發版。

---

## 回報 SOP(每一項 FAIL 都照這個做)

1. Settings(You 分頁右上角齒輪)→ 打開 **Debug mode**。
2. 回到 live 畫面,左上角會出現 **DETECT DEBUG** 面板。
3. 按面板底部的 **「⧉ COPY DIAG」**,把整段 **HOOPILOT DIAG** 文字貼回對話。
4. 同時附上該段操作的**螢幕錄影**(iPhone:控制中心螢幕錄製;Android:快速設定螢幕錄影)。

> 🔴 **紅字鐵則:任何一個「假 make」(S4a、S4b、S5)= release blocker,當天必修;
> 其餘 FAIL 記 issue 可擇期修。**

每一項的格式固定為:

- **編號**
- **步驟**(照順序做)
- **預期結果**
- **結果:☐ PASS ☐ FAIL**
- **失敗時回報**:照上方【回報 SOP】— COPY DIAG 貼回 + 螢幕錄影該段

---

## S0 安裝與版本

### S0-1 iPhone 側載
- 步驟:
  1. 在 repo 執行 `gh workflow run ios-ipa.yml`(或 GitHub → Actions → **iOS IPA (unsigned, for sideloading)** → Run workflow)。
  2. 跑完後從 **`ios-ipa-latest`** release 下載 `HoopAI-unsigned.ipa`。
  3. 用 **Sideloadly**(或 AltStore)+ 免費 Apple ID 側載到 iPhone;手機上 Settings → General → VPN & Device Management → 信任該 Apple ID。
  4. 開啟 app。
- 預期結果:app 正常開啟、無閃退;Settings 底部 About 區的 **Version** 列顯示本次 build 的版本號。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】(裝不起來就附 Sideloadly 錯誤截圖)。

### S0-2 Android 側載
- 步驟:
  1. GitHub → Releases → **`android-latest`** → 下載 `HoopAI.apk`。
  2. 手機直接點開安裝(允許「安裝未知的應用程式」)。
  3. 開啟 app。
- 預期結果:同 S0-1 — 開啟正常、版本號正確、無閃退。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】。

---

## S1 冷啟與 onboarding

### S1-1 全新安裝首開
- 步驟:
  1. 確認是**全新安裝**(舊版先刪掉)。
  2. 首次開啟 app。
- 預期結果:onboarding 流程出現(不是直接進首頁)。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】。

### S1-2 全部 Skip
- 步驟:
  1. onboarding 的每一個資料題都按右上角 **Skip**。
  2. 走完後觀察落點。
  3. 完全關閉 app(上滑殺掉)再重開。
- 預期結果:Skip 全程可用;結束後落在 **Home** 分頁;重開後 onboarding **不再出現**。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】。

### S1-3 冷啟速度(手感)
- 步驟:
  1. 殺掉 app 後重新開啟,從點 icon 到首頁可互動計時。
- 預期結果:< 2.5 秒(手感即可,不用碼錶到毫秒)。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】+ 註明機型。

---

## S2 Demo 模式(不需球場,第一道閘)

> 程式行為:demo 模式只在「裝置沒有相機」時自動啟動(`useShotEngine` 的 auto 判定)——
> 也就是 **iOS Simulator / 無相機裝置**。實機一定走 camera,這是刻意設計(scripted 資料
> 絕不能混進真實數據)。所以本節分兩項:模擬器正向 + 實機反向。

### S2-1 模擬器 demo 全流程(有 Mac / Simulator 才跑,否則標 N/A)
- 步驟:
  1. 跑 `ios-simulator.yml` workflow 拿 Simulator build,裝進 iOS Simulator。
  2. Home → **Start session** → 進 live 畫面。
  3. 確認頂部出現 **「DEMO MODE — scripted scene」** 徽章、畫面是刻畫的球場(DemoCourt)。
  4. 讓 scripted 場景跑幾顆模擬投籃,觀察 HUD:彗尾軌跡、ShotFlash、ShotToast(MAKE/MISS)、StatStrip(Points / Made / FG% / Streak)更新。
  5. 按 **End session** → 確認 → 進 summary。
- 預期結果:全程無當機;summary 的統計數字與 live 時 ShotToast / StatStrip 看到的一致。
- 結果:☐ PASS ☐ FAIL ☐ N/A(無 Simulator)
- 失敗時回報:照【回報 SOP】。

### S2-2 實機絕不出現 DEMO 徽章(誠實檢查)
- 步驟:
  1. 在實機開一場正常 camera session,掃一眼頂部 HUD。
- 預期結果:**「DEMO MODE — scripted scene」徽章絕不出現** — 實機資料必須全部來自真鏡頭。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】(這個 FAIL 視同資料污染,優先級同 blocker)。

---

## S3 鎖框與瞄準

### S3-1 自動鎖框
- 步驟:
  1. Home → **Start session**,setup 選 **Portrait**,架好手機對準籃框(三腳架或靠包包)。
  2. 觀察瞄準畫面:模型載入時顯示「Waking up the AI…」;之後出現**虛線 ghost rim** 輪廓與「Frame the hoop over the ghost rim」提示,以及 Good/OK/Poor 擺位評分 chip。
  3. 把真籃框對進 ghost rim,持穩。
- 預期結果:出現「Hold steady — locking on the rim」+ **3-2-1 倒數大數字**;倒數完鎖框,有音效(rim_locked)/ 震動;正常光線下從對準到鎖框 **< 4 秒**(不含模型暖機)。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】。

### S3-2 tap-to-set-rim 手動點框
- 步驟:
  1. 在瞄準階段(還沒鎖框)直接**用手指點畫面上的真籃框位置**(提示文案就是「…or tap the rim to place it yourself」)。
- 預期結果:立即以點的位置鎖框,不用等倒數。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】。

### S3-3 Re-aim 重來
- 步驟:
  1. 鎖框後按底部 **Re-aim** 按鈕。
- 預期結果:回到瞄準狀態(ghost rim 重新出現),重新持穩後 3-2-1 倒數**重來一次**,再次鎖框。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】。

---

## S4 判定核心腳本(最重要的一節)

> 實投 **10 顆進 + 10 顆不進**,外加三個專門釘鐵律的反例。每一顆都看 live 上的 ShotToast
>(MAKE / MISS / REVIEW chip + 迷你軌跡線),結束後到 summary 的 **Box score** 展開每顆的
> 證據收據(**PATH / NET / SEEN** 三行)核對。

### S4-1 十進十不進基準
- 步驟:
  1. 鎖框後正常投 10 顆進、10 顆不進(距離混合:近距 / 罰球 / 三分)。
  2. 每顆記下 ShotToast 顯示的結果;REVIEW(unsure)另外記。
  3. End session → summary → Box score 逐顆展開收據核對。
- 預期結果:20 顆中**誤判 ≤ 2**(unsure 不算誤判);每顆都有 ShotToast;收據的 PATH / NET / SEEN 與實際情況合理對應。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】+ 每顆誤判註明「實際 / app 判定」。

### S4-2 反例 (a) 麵包球(bread-ball)🔴
- 步驟:
  1. 把球從籃框**前方**拋過 / 或讓球在框上滾一圈滾出 — 球的路徑會穿過框的 2D 投影,但**沒有下網**。
  2. 重複 3 次。
- 預期結果:**絕不能記 MAKE**。判 MISS 或 REVIEW 都可接受。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】+ 錄影必附(這是 release blocker)。

### S4-3 反例 (b) pass-through(水平穿越)🔴
- 步驟:
  1. 請一個人把球**水平傳過**籃框的 2D 投影區(從框旁邊平傳,球在畫面上「穿過」框的高度)。
  2. 重複 3 次。
- 預期結果:**絕不能產生 attempt**(StatStrip 的出手數不動、沒有 ShotToast)。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】+ 錄影必附(這是 release blocker)。

### S4-4 反例 (c) 打板 / 彈框後進
- 步驟:
  1. 投 3 顆「打板進」或「在框上彈跳一兩下才掉進去」的球。
- 預期結果:**必須記 MAKE**(net 延遲確認窗要接得住彈框後才下網的情況)。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】。

---

## S5 遮擋誠實性(ROI 鐵律)🔴

### S5-1 框後 / 框前角度的遮擋 miss
- 步驟:
  1. 把手機架在**籃框正後方或正前方**的低角度,讓球在框附近會被框體 / 籃板遮住。
  2. 投 **5 顆不進**的球(彈框出、擦框出)。
- 預期結果:全部判 **MISS 或 REVIEW** — **0 顆假 MAKE**。REVIEW 偏多是可接受的(誠實地說「看不清楚」),假 MAKE 是 blocker。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】+ 錄影必附(假 MAKE = release blocker)。

---

## S6 飛行弧線(視覺 only)

### S6-1 弧線開關
- 步驟:
  1. Settings → Debug mode ON → 找到 **Full-flight tracking** 開關,確認 **ON**(預設)。
  2. 開一場 session 投幾顆:觀察整段飛行有彗尾 / 虛線弧線 / 落點標記。
  3. 回 Settings 把 **Full-flight tracking** 關掉,再投幾顆。
- 預期結果:ON 時整段飛行有弧線視覺;OFF 時弧線視覺消失;兩種狀態下 app 都不當機。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】。

### S6-2 弧線只畫圖不判球(鐵律)
- 步驟:
  1. 用**同一批投籃腳本**(例如各投 5 進 5 不進)在 ON / OFF 各跑一輪。
- 預期結果:**兩輪的判定結果一致**(同樣的球判同樣的 make/miss;個別 unsure 浮動可接受,但不能出現「ON 才有的 make」)。弧線是視覺層,永遠不改變判定。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】+ 兩輪的逐球對照表。

---

## S7 暗光與無網籃框

### S7-1 暗光
- 步驟:
  1. 傍晚或室內偏暗環境(DETECT DEBUG 的 **light** 列會顯示 dim/dark 可佐證)投 5 顆。
- 預期結果:追蹤變弱、REVIEW 變多都可接受;**不可出現假 MAKE**;app 不當機。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】(把 DIAG 的 light 數值一起貼)。

### S7-2 無網(或網極短)籃框
- 步驟:
  1. 找一個沒有網的籃框投 5 顆進的球。
- 預期結果:沒有網的動靜可看,**純球路徑(收據上 PATH)仍然判得出 MAKE** — geo 路徑是主判定,不依賴網。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】。

---

## S8 校正儀式

### S8-1 FT(罰球線)校正
- 步驟:
  1. 鎖框後,頂部會出現 chip:**「Boost 2/3 accuracy — tap to calibrate at the FT line」**。先**不要按**,等 20 秒。
  2. 確認 chip 20 秒後自動消失(不糾纏)。
  3. Re-aim 重新鎖框讓 chip 再出現;這次站到罰球線上按下 chip。
  4. 照「Hold still at the line… 3/2/1」倒數站穩。
- 預期結果:chip 20 秒自動消失;按了之後 3-2-1 倒數 → 顯示 **「Calibrated ✓」**(失敗會顯示「Couldn't calibrate — skipped」且不影響後續)。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】。

### S8-2 Court 校正(五點地標)
- 步驟:
  1. 鎖框後按底部 **Calibrate** 按鈕。
  2. 照畫面指示逐一點出球場地標(例如「Tap the middle of the free-throw line」),點錯可 Undo。
  3. 全部點完按 Confirm。
  4. 之後投幾顆 2 分 / 3 分球,End session 後在 Box score 展開收據。
- 預期結果:校正完成;之後的球收據上 2/3 分來源顯示 **「Court-registered」**。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】。

### S8-3 Drift 失效(踢腳架測試)
- 步驟:
  1. 在 S8-1 + S8-2 都完成的狀態下,**輕碰一下腳架**讓鏡頭明顯移位。
  2. 觀察頂部橫幅;等它重新鎖上(或手動 Re-aim)。
  3. 再投球看收據來源。
- 預期結果:出現 **「Camera moved — re-aiming…」** 橫幅;重新鎖框後 **FT 與 Court 校正都必須失效**(收據來源退回估計 / 需要重新校正)— 舊校正絕不能沿用到移動後的鏡頭。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】。

---

## S9 錄影 / 回放 / 重判

> 前置:Settings → Video → **Record sessions** ON。

### S9-1 replay marker 對時
- 步驟:
  1. 錄影開著跑一場(≥ 8 顆,混進與不進)。
  2. End → summary → **Watch replay**。
  3. 逐一點時間軸上的每個 shot marker。
- 預期結果:每個 marker 跳到影片中該球出手前後的正確秒數(**誤差 ±1s**);marker 顏色與判定一致。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】+ 指出偏移的是第幾顆、偏了幾秒。

### S9-2 Recheck 不蓋 Edited 章
- 步驟:
  1. 找一場**有 REVIEW(unsure)球**的錄影場次(summary 或 Data 分頁 → 該場)。
  2. 按 **「Re-check N unsure shots」**,等「Re-checking i of N…」跑完。
  3. 看被機器改判成 make/miss 的那些球在列表上的徽章。
- 預期結果:機器重判的球**不能**出現 **「Edited」** 徽章(Edited 只留給人手改判);重判後仍叫不準的球出現 Make / Miss 人工 triage 按鈕,用它手動判的球**才**得到 Edited。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】。

---

## S10 資料完整性

### S10-1 改判 + Undo
- 步驟:
  1. summary 的 Box score 對某一顆球**滑動改判**(右滑 = make、左滑 = miss)。
  2. 底部 UNDO snackbar 出現時按 **UNDO**(約 4 秒窗口)。
- 預期結果:改判即時生效(數字跟著動、該球出現 Edited 徽章);UNDO 完整還原(結果與徽章都復原,不留 Edited)。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】。

### S10-2 History / Trends / Records
- 步驟:
  1. Data 分頁找到剛結束的場次,核對卡片數字與 summary 一致。
  2. 開 **Trends**、開 **Records**,各滑動瀏覽一輪。
- 預期結果:數字一致;Trends / Records 開啟與滑動皆不當機。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】。

### S10-3 Backup 匯出→重裝→匯入
- 步驟:
  1. Settings → Data → **Export all data**,把 backup 檔存起來(分享給自己)。
  2. 刪掉 app → 重新安裝 → 跳過 onboarding。
  3. Settings → Data → **Import data**,把 backup 內容貼進貼上視窗送出。
  4. 到 Data 分頁核對。
- 預期結果:顯示「Imported N, skipped 0」;場次數、每場球數、make/miss、2/3 分與其來源(含 Court-registered)**完整回來**;Records 的成就 / 挑戰點數也在。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】+ 匯入時的錯誤文案原文。

---

## S11 熱與續航(20 分鐘 soak)

### S11-1 連續 session
- 步驟:
  1. Debug mode ON,開一場 session 連續跑 **20 分鐘**(有一搭沒一搭投球即可,重點是連續運轉)。
  2. 全程注意:偵測心跳 chip(Tracking / Weak signal / No detection)、機身溫度、有無降頻感。
  3. 結束前抄下 DETECT DEBUG 面板的 **delegate**、**speed(fps · avgMs)** 列,並按 **⧉ COPY DIAG** 把整段貼回。
- 預期結果:20 分鐘內 app 不當機、偵測不停止(心跳不長時間卡在 No detection);結束後 DIAG 數字貼回對話。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】。
- 備註:**這組 avgMs/fps 數字決定 perfMode 預設值(對應 MASTER-PLAN D01),一定要貼回來。**

---

## S12 橫向與方向鎖

### S12-1 landscape 全流程
- 步驟:
  1. Start session → setup 選 **Landscape**(Propped on its side)→ 跑一場短 session。
  2. 檢查:DETECT DEBUG 面板停靠右上、StatStrip 靠左欄、偵測框(Debug mode 下)貼合真球 / 真框。
- 預期結果:HUD 疊層不錯位;overlay 框對齊實物;鎖框 / 投籃 / End 全流程正常。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】+ 截圖。

### S12-2 session 中轉動手機
- 步驟:
  1. session 進行中把手機轉 90 度再轉回來。
- 預期結果:方向在 session 內是**鎖定**的 — 畫面不亂轉、overlay 不錯位、判定不受影響。
- 結果:☐ PASS ☐ FAIL
- 失敗時回報:照【回報 SOP】。

---

## 回報格式(全部跑完後貼回對話)

```
HOOPILOT SMOKE REPORT — build vX.Y.Z / 日期
S0-1: PASS/FAIL    S0-2: PASS/FAIL
S1-1: PASS/FAIL    S1-2: PASS/FAIL    S1-3: PASS/FAIL
S2-1: PASS/FAIL/N.A.  S2-2: PASS/FAIL
S3-1: PASS/FAIL    S3-2: PASS/FAIL    S3-3: PASS/FAIL
S4-1: PASS/FAIL(誤判 x/20)
S4-2: PASS/FAIL 🔴  S4-3: PASS/FAIL 🔴  S4-4: PASS/FAIL
S5-1: PASS/FAIL 🔴(假 make x/5)
S6-1: PASS/FAIL    S6-2: PASS/FAIL
S7-1: PASS/FAIL    S7-2: PASS/FAIL
S8-1: PASS/FAIL    S8-2: PASS/FAIL    S8-3: PASS/FAIL
S9-1: PASS/FAIL    S9-2: PASS/FAIL
S10-1: PASS/FAIL   S10-2: PASS/FAIL   S10-3: PASS/FAIL
S11-1: PASS/FAIL
S12-1: PASS/FAIL   S12-2: PASS/FAIL
```

- 每個 FAIL 附:該項的 **HOOPILOT DIAG** 貼文 + 螢幕錄影。
- S11 延遲表(每台測過的機型一列):

| 機型 | delegate | avgMs | fps |
|---|---|---|---|
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |

> 🔴 **任何『假 make』(S4-2 / S4-3 / S5-1)= release blocker,其餘 FAIL 記 issue 可擇期修。**
