import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { LanguageModelMiddleware } from "ai";

/**
 * Ends an aborted model call by reading its stream to the end instead of cancelling it.
 *
 * When a run is aborted (stop, time limit, shutdown), the AI SDK cancels the step's stream while the
 * aborted request is failing it. @openrouter/ai-sdk-provider (3.1.0) cancels its inner stream without
 * catching, so if the cancel lands while that error is on its way, the rejection is unhandled and
 * Node exits. Read to the end, the stream finishes through the provider's own error handling: the
 * aborted request ends it right away.
 */
export const drainOnAbort: LanguageModelMiddleware = {
  wrapStream: async ({ doStream, params }) => {
    const result = await doStream();
    const reader = result.stream.getReader();
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (err) {
          controller.error(err);
        }
      },
      cancel(reason) {
        if (params.abortSignal?.aborted) void drain(reader);
        else return reader.cancel(reason).catch(() => {});
      },
    });
    return { ...result, stream };
  },
};

async function drain(reader: ReadableStreamDefaultReader<unknown>): Promise<void> {
  try {
    while (!(await reader.read()).done) {}
  } catch {
    // It failed: it's over either way.
  }
}
