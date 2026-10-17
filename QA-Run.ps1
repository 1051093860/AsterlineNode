<# Run from AsterlineNode root. By default: no installs, no sandbox, no production DB changes. #>
param([switch]$Online,[switch]$Sandbox,[switch]$Notify,[switch]$Keep,[ValidateSet('all','unit','staging','diagnose','sandbox')][string]$Mode='all')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Push-Location $PSScriptRoot
try {
  $arguments=@('scripts/qa/main.mjs', $Mode)
  if($Online){$arguments+='--online'}
  if($Sandbox){$arguments+='--sandbox'}
  if($Keep){$arguments+='--keep'}
  if($Notify){$arguments+='--notify'}
  & node @arguments
  if($LASTEXITCODE -ne 0){throw "QA exit code $LASTEXITCODE. Please view qa-reports for details."}
} finally {Pop-Location}
