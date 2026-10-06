import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export async function importTypeScriptModule(file) {
  const sourceUrl = pathToFileURL(file).href;
  const source = await readFile(file, "utf8");
  const result = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    throw new Error(ts.formatDiagnostics(errors, {
      getCanonicalFileName: name => name,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    }));
  }
  const encoded = Buffer.from(`${result.outputText}\n//# sourceURL=${sourceUrl}`, "utf8").toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}
