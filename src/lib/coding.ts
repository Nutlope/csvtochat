import { codeInterpreter } from "@/lib/clients";
import { CodeInterpreterExecuteParams } from "together-ai/resources.mjs";

interface CodeInterpreterOutput {
  type: string;
  data: string;
}

interface CodeInterpreterError {
  // Define error structure if available from the API, otherwise use any
  message: string;
}

export interface TogetherCodeInterpreterResponseData {
  session_id: string;
  status: string;
  outputs: CodeInterpreterOutput[];
  errors?: CodeInterpreterError[];
}

interface RunPythonResult {
  session_id: string | null;
  status: string;
  outputs: CodeInterpreterOutput[];
  errors?: CodeInterpreterError[];
  error_message?: string;
}

/**
 * Executes Python code using Together Code Interpreter and returns the result.
 * @param code The Python code to execute
 * @returns The output of the executed code as a JSON
 */
export async function runPython(code: string): Promise<RunPythonResult> {
  try {
    const kwargs: CodeInterpreterExecuteParams = { code, language: "python" };

    const response = await codeInterpreter.execute(kwargs);

    const data = response.data as TogetherCodeInterpreterResponseData;

    const result: RunPythonResult = {
      session_id: data.session_id || null,
      status: data.status || "unknown",
      outputs: [],
    };

    if (data.outputs) {
      for (const output of data.outputs) {
        result.outputs.push({ type: output.type, data: output.data });
      }
    }

    if (data.errors) {
      result.errors = data.errors;
    }

    return result;
  } catch (e) {
    console.error("Code Interpreter request failed:", e);
    const error_result: RunPythonResult = {
      status: "error",
      error_message: "Code execution failed.",
      session_id: null,
      outputs: [],
    };
    return error_result;
  }
}
