<#
    Keyring - one-shot repo setup.

    Creates the git repo, makes the first commit, creates the repo on
    GitHub as PRIVATE, and pushes. Safe to re-run: it stops rather than
    clobbering anything that already exists.

    Run it from this folder:

        .\bootstrap.ps1

    Optional:
        .\bootstrap.ps1 -RepoName my-vault -Public
        .\bootstrap.ps1 -Owner someuser

    Works on Windows PowerShell 5.1 and PowerShell 7+.
#>

[CmdletBinding()]
param(
    [string]$RepoName = 'keyring-vault',
    [switch]$Public,
    [string]$Owner
)

$ErrorActionPreference = 'Stop'

# PowerShell 7.3+ turns a non-zero exit from git/gh into a terminating
# error. Several checks below read $LASTEXITCODE instead, so opt out.
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $global:PSNativeCommandUseErrorActionPreference = $false
}

Set-Location -Path $PSScriptRoot

function Say  { param($m) Write-Host "  $m" }
function Good { param($m) Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Die  { param($m) Write-Host "  [x]  $m" -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host '  Keyring -> GitHub' -ForegroundColor Cyan
Write-Host '  =================' -ForegroundColor Cyan
Write-Host ''

# --- prerequisites -------------------------------------------------------
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Die 'git is not installed. Get it from https://git-scm.com/download/win'
}
$gitVersion = (git --version) -replace 'git version ', ''
Good "git $gitVersion"

$hasGh = [bool](Get-Command gh -ErrorAction SilentlyContinue)
if ($hasGh) {
    $ghLine = @(gh --version)[0]
    $ghVersion = $ghLine -replace 'gh version ', ''
    $ghVersion = $ghVersion.Split(' ')[0]
    Good "gh $ghVersion"
} else {
    Warn 'GitHub CLI not found - I will set the repo up locally and tell you how to push.'
    Warn 'For the one-command version: winget install GitHub.cli'
}

# --- who are we ----------------------------------------------------------
if ($hasGh -and -not $Owner) {
    gh auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Warn 'Not signed in to GitHub CLI. Starting login...'
        gh auth login
        if ($LASTEXITCODE -ne 0) { Die 'Login did not complete.' }
    }
    $Owner = gh api user --jq .login 2>$null
    if ($LASTEXITCODE -ne 0) { $Owner = '' }
    if ($Owner) { Good "signed in as $Owner" }
}
if (-not $Owner) {
    $Owner = Read-Host '  Your GitHub username'
    if (-not $Owner) { Die 'Need a username to build the repo URL.' }
}

# --- git identity --------------------------------------------------------
$cfgEmail = git config --global user.email 2>$null
if (-not $cfgEmail) {
    $cfgEmail = Read-Host '  git user.email (once, for commit authorship)'
    git config --global user.email $cfgEmail
}
$cfgName = git config --global user.name 2>$null
if (-not $cfgName) {
    $cfgName = Read-Host '  git user.name'
    git config --global user.name $cfgName
}

# --- badge URLs ----------------------------------------------------------
$readme = Join-Path $PSScriptRoot 'README.md'
if (Test-Path $readme) {
    # Read and write as UTF-8 explicitly. Windows PowerShell 5.1 defaults
    # to the ANSI codepage, which would mangle the emoji in the README.
    $text = [System.IO.File]::ReadAllText($readme)
    if ($text.Contains('OWNER_PLACEHOLDER')) {
        $text = $text.Replace('OWNER_PLACEHOLDER', $Owner)
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($readme, $text, $utf8NoBom)
        Good "pointed the README badges at $Owner"
    }
}

# --- GitHub Actions workflow ---------------------------------------------
# Shipped as ci-workflow.yml because remote tools may not write into
# .github/workflows. Put it where GitHub expects it.
$staging  = Join-Path $PSScriptRoot 'ci-workflow.yml'
$wfDir    = Join-Path $PSScriptRoot '.github\workflows'
$wfTarget = Join-Path $wfDir 'ci.yml'
if (Test-Path $staging) {
    if (Test-Path $wfTarget) {
        Warn 'ci.yml already exists - leaving it, removing the staging copy.'
        Remove-Item -LiteralPath $staging -Force
    } else {
        New-Item -ItemType Directory -Path $wfDir -Force | Out-Null
        Move-Item -LiteralPath $staging -Destination $wfTarget -Force
        Good 'installed .github\workflows\ci.yml'
    }
}

# --- repo ----------------------------------------------------------------
if (Test-Path (Join-Path $PSScriptRoot '.git')) {
    Warn 'Already a git repo - leaving its history alone.'
} else {
    git init -b main 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        git init | Out-Null
        git branch -M main | Out-Null
    }
    Good 'initialised a repo on main'
}

git add -A
$staged = @(git diff --cached --name-only)

# --- guard: never commit a real vault ------------------------------------
$leaked = @($staged | Where-Object {
    $_ -match 'vault\.json$' -or $_ -match 'keyring-(backup|PLAINTEXT)-.*\.json$'
})
if ($leaked.Count -gt 0) {
    Write-Host ''
    $list = $leaked -join ', '
    Die "Refusing to continue - these look like real vault data: $list"
}

if ($staged.Count -gt 0) {
    $summary = @'
A single-file vault for API keys, with an optional sync server that
only ever sees ciphertext.

- AES-256-GCM with PBKDF2-SHA256 key derivation, all in the browser
- Issuer / app / stack / URL / tags / expiry / notes per entry
- Copy button on every value, masked until revealed
- Optional multi-device sync, tombstoned deletes, merge on conflict
- Portainer stack: Caddy for HTTPS, a small Node service for storage
- 50 browser-driven checks across two suites
'@
    $msg = "Keyring: self-hosted encrypted API key vault`n`n" + $summary
    $msgFile = Join-Path ([System.IO.Path]::GetTempPath()) 'keyring-commit-msg.txt'
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($msgFile, $msg, $utf8NoBom)
    git commit -F $msgFile | Out-Null
    $commitCode = $LASTEXITCODE
    Remove-Item -LiteralPath $msgFile -Force -ErrorAction SilentlyContinue
    if ($commitCode -ne 0) { Die 'git commit failed.' }
    $n = $staged.Count
    Good "committed $n files"
} else {
    Warn 'Nothing new to commit.'
}

# --- push ----------------------------------------------------------------
Write-Host ''
if (-not $hasGh) {
    if ($Public) { $vis = 'public' } else { $vis = 'private' }
    Say "Create an empty $vis repo named '$RepoName' at https://github.com/new"
    Say 'then run:'
    Write-Host ''
    Write-Host "      git remote add origin https://github.com/$Owner/$RepoName.git" -ForegroundColor White
    Write-Host '      git push -u origin main' -ForegroundColor White
    Write-Host ''
    exit 0
}

$remotes = @(git remote)
if ($remotes -contains 'origin') {
    Warn "A remote named 'origin' already exists - pushing to it."
    git push -u origin main
    if ($LASTEXITCODE -ne 0) { Die 'Push failed.' }
} else {
    if ($Public) { $visFlag = '--public' } else { $visFlag = '--private' }
    Say "Creating $Owner/$RepoName ..."
    gh repo create $RepoName $visFlag --source=. --remote=origin --push
    if ($LASTEXITCODE -ne 0) { Die 'gh could not create the repo. Is the name already taken?' }
}

Write-Host ''
Good "Done: https://github.com/$Owner/$RepoName"
Write-Host ''
