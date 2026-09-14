import { collectDiagnostics, formatDiagnostics } from "../src/diagnostics";

try {
  const report = await collectDiagnostics({
    projectsDir: process.env.PROJECTS_DIR ?? "/home/agent/projects",
    env: process.env,
  });
  console.log(formatDiagnostics(report));
  process.exitCode = report.hasBlockers ? 1 : 0;
} catch {
  console.error(
    "Diagnostica non completata: errore durante i controlli locali."
  );
  process.exitCode = 1;
}
