$ErrorActionPreference = "Stop"
& codex plugin add codenode@personal
if ($LASTEXITCODE -ne 0) { throw "codex plugin add failed: $LASTEXITCODE" }
& codex plugin list
if ($LASTEXITCODE -ne 0) { throw "codex plugin list failed: $LASTEXITCODE" }
