import asyncio
import os
from dotenv import load_dotenv
from google.adk.runners import Runner, RunConfig
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.adk.sessions.in_memory_session_service import InMemorySessionService
from google.genai import types
from google.genai.types import Modality
from agent import root_agent


async def main():
    # .env から API キーを読み込む
    load_dotenv()

    # セッションサービスの初期化
    session_service = InMemorySessionService()

    # ADK Runner の初期化（auto_create_session=True を追加）
    runner = Runner(
        app_name="my_bidi_agent",
        agent=root_agent,
        session_service=session_service,
        auto_create_session=True,
    )

    # ユーザー入力を非同期に受け取るためのキュー
    input_queue = LiveRequestQueue()

    print("Bidi-streaming Agent started. Type 'exit' to quit.")

    # 非同期タスク: ユーザーの入力を待ち受けてキューに入れる
    async def get_user_input():
        while True:
            text = await asyncio.to_thread(input, "User: ")
            if text.lower() == "exit":
                input_queue.close()
                break
            # プレーンテキストを types.Content に変換して送信
            content = types.Content(parts=[types.Part(text=text)])
            input_queue.send_content(content)

    # 非同期タスク: エージェントを実行し、レスポンスをストリーミングで受け取る
    async def process_responses():
        try:
            # run_live() を使って双方向ストリーミングを実行
            async for event in runner.run_live(
                user_id="default_user",
                session_id="default_session",
                live_request_queue=input_queue,
            ):
                # Event オブジェクトからテキストを抽出
                if event.content and event.content.parts:
                    for part in event.content.parts:
                        if part.text:
                            print(f"Agent: {part.text}", end="", flush=True)

                # レスポンスが完了したか確認
                if event.is_final_response():
                    print("\n")
        except Exception as e:
            print(f"\nError in processing responses: {e}")

    # 両方のタスクを並行実行
    await asyncio.gather(get_user_input(), process_responses())


if __name__ == "__main__":
    asyncio.run(main())
