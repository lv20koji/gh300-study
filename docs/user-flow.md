# ユーザーフロー（UML）

## 学習セッションの流れ（シーケンス図）

```mermaid
sequenceDiagram
    actor User as 利用者
    participant UI as ポータル画面
    participant App as app.js
    participant Data as questions.json
    participant Store as localStorage

    User->>UI: アプリを開く
    UI->>Store: 進捗・学習記録を読み込む
    Store-->>UI: 復習期限件数・ストリーク
    UI-->>User: 今日の復習件数とフォーキャストを表示
    User->>UI: 科目と学習モードを選択
    UI->>App: セッション開始
    App->>Data: 科目パックを取得
    Data-->>App: 問題一覧
    App-->>UI: 出題（期限到来分＋分野別など）
    loop セッション終了まで
        User->>UI: 選択肢をタップ
        UI->>App: 回答を判定
        alt 不正解
            App-->>UI: 間違い理由（wrongNote）を表示
            App->>Store: 間違いノートに記録
        end
        App->>App: SM-2 で間隔と次回期限を更新
        App->>Store: カード状態を保存
    end
    User->>UI: セッション終了
    UI->>Store: 学習時間を記録
    UI-->>User: 結果・ストリーク・カレンダーを更新表示
```

## 問題カードの状態遷移（状態遷移図）

```mermaid
stateDiagram-v2
    [*] --> 未学習
    未学習 --> 学習中 : 初回出題
    学習中 --> 復習待ち : 正解（間隔を延長）
    学習中 --> 学習中 : 不正解（間隔を短縮）
    復習待ち --> 学習中 : 期限到来で再出題
    復習待ち --> 定着 : 連続正解で間隔が十分に拡大
    定着 --> 学習中 : 弱点集中・間違いノートから復習
```

## モード別の違い

| モード | 出題対象 | 採点タイミング | SM-2 への反映 |
|---|---|---|---|
| 通常学習 | 期限到来カード＋分野別ドリル | 即時 | あり |
| 弱点集中 | 間違い履歴・低 ease のカード（最大 20 問） | 即時 | あり |
| ランダムミニテスト | ランダム 10 問 | 最後に一括（タイマー付き） | なし（学習時間のみ記録） |
| フラッシュカード | カード形式で自己評価 | 自己申告 | あり |
