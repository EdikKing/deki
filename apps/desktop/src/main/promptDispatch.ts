export type PromptDispatchMode = "foreground" | "background";

export type PromptDispatchDecision =
  | { ok: true; preferFork: boolean }
  | { ok: false; error: string };

export function decidePromptDispatch(input: {
  mode: PromptDispatchMode;
  sessionStreaming: boolean;
  hasPendingSessionTask: boolean;
}): PromptDispatchDecision {
  if (input.mode === "foreground" && input.sessionStreaming) {
    return {
      ok: false,
      error: "当前会话正在运行，请使用“后台运行”提交新任务",
    };
  }
  if (input.mode === "foreground" && input.hasPendingSessionTask) {
    return {
      ok: false,
      error: "当前会话仍在收尾，请稍后重试",
    };
  }
  return {
    ok: true,
    preferFork: input.mode === "background",
  };
}
