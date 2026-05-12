import { Database } from "bun:sqlite";
import { randomBytes } from "crypto";

const db = new Database(process.env.USERPROFILE + "/.archon/archon.db", { readwrite: true });

function newId() {
  return randomBytes(16).toString("hex");
}

const repos = [
  {
    name: "repos/TrialMatch-FE",
    default_cwd: "C:/Repos/TrialMatch/repos/TrialMatch-FE",
    default_branch: "develop",
    repository_url: "git@github-trabajo:Third-Opinion/TrialMatch-FE.git",
  },
  {
    name: "repos/TrialMatch-BE",
    default_cwd: "C:/Repos/TrialMatch/repos/TrialMatch-BE",
    default_branch: "develop",
    repository_url: "git@github-trabajo:Third-Opinion/TrialMatch-BE.git",
  },
];

// Clear existing
db.run("DELETE FROM remote_agent_codebases");

for (const repo of repos) {
  const id = newId();
  db.run(
    "INSERT INTO remote_agent_codebases (id, name, default_cwd, default_branch, repository_url, ai_assistant_type) VALUES (?, ?, ?, ?, ?, ?)",
    [id, repo.name, repo.default_cwd, repo.default_branch, repo.repository_url, "claude-code"]
  );
  console.log(`Inserted: ${repo.name} (id=${id})`);
}

const all = db.query("SELECT id, name, default_cwd FROM remote_agent_codebases").all();
console.log("\nAll codebases:", JSON.stringify(all, null, 2));
db.close();
