<#
.SYNOPSIS
  Meeting Notes Obsidian 플러그인 설치 (Windows)
.DESCRIPTION
  볼트에 플러그인을 넣고, 로컬 전사에 필요한 ffmpeg·whisper.cpp·모델을 준비하고, API 키 파일 템플릿을 만든다.
  여러 번 실행해도 안전하다(있는 것은 건너뜀).
.EXAMPLE
  irm https://raw.githubusercontent.com/kyun9hwan-slug/kei-obsidian-plugin-meetingnote/main/install.ps1 | iex
  .\install.ps1 -Vault "D:\Notes\MyVault"
  .\install.ps1 -Vault "D:\Notes\MyVault" -SkipWhisper     # API 전사만 쓸 때
#>
param(
  [string]$Vault = "",
  [switch]$SkipWhisper,
  [string]$Repo = "kyun9hwan-slug/kei-obsidian-plugin-meetingnote",
  [string]$PluginId = "meeting-notes",
  [string]$ConfigDir = "obsidian-meeting-notes"
)
$ErrorActionPreference = "Stop"
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "   OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "   !!  $m" -ForegroundColor Yellow }

# ---------- 1. 볼트 찾기
Step "Obsidian 볼트"
if (-not $Vault) {
  $reg = Join-Path $env:APPDATA "obsidian\obsidian.json"
  if (Test-Path $reg) {
    $vaults = (Get-Content $reg -Raw | ConvertFrom-Json).vaults.PSObject.Properties | ForEach-Object { $_.Value.path }
    if ($vaults.Count -eq 1) { $Vault = $vaults[0] }
    elseif ($vaults.Count -gt 1) {
      Write-Host "   볼트가 여러 개입니다. -Vault 인자로 하나를 지정하세요:"
      $vaults | ForEach-Object { Write-Host "     $_" }
      exit 2
    }
  }
}
if (-not $Vault -or -not (Test-Path $Vault)) { Write-Host "   볼트 경로를 찾지 못했습니다. -Vault 'C:\path\to\vault' 로 지정하세요." -ForegroundColor Red; exit 2 }
Ok $Vault

# ---------- 2. 플러그인 파일
Step "플러그인 파일 ($PluginId)"
$dst = Join-Path $Vault ".obsidian\plugins\$PluginId"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
foreach ($f in @("main.js","manifest.json","styles.css")) {
  Invoke-WebRequest -UseBasicParsing "https://github.com/$Repo/releases/latest/download/$f" -OutFile (Join-Path $dst $f)
}
$ver = (Get-Content (Join-Path $dst "manifest.json") -Raw | ConvertFrom-Json).version
Ok "버전 $ver → $dst"

# 활성화 목록에 추가 (Obsidian이 켜져 있으면 덮어쓸 수 있으므로 재시작 안내)
$cp = Join-Path $Vault ".obsidian\community-plugins.json"
$list = @(); if (Test-Path $cp) { $list = @(Get-Content $cp -Raw | ConvertFrom-Json) }
if ($list -notcontains $PluginId) { $list += $PluginId; ($list | ConvertTo-Json) | Set-Content $cp -Encoding UTF8; Ok "community-plugins.json 에 등록" }
else { Ok "이미 등록됨" }
if (Get-Process -Name Obsidian -ErrorAction SilentlyContinue) { Warn "Obsidian이 실행 중입니다. 설치 후 Obsidian을 완전히 종료하고 다시 여세요." }

# ---------- 3. ffmpeg / whisper / 모델
if (-not $SkipWhisper) {
  Step "ffmpeg"
  if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { Ok (Get-Command ffmpeg).Source }
  else {
    winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements | Out-Null
    Ok "winget 으로 설치. PATH 반영을 위해 새 터미널/Obsidian 재시작이 필요합니다."
  }

  Step "whisper.cpp"
  $wdir = Join-Path $env:LOCALAPPDATA "whisper-cpp"
  $wcli = Join-Path $wdir "whisper-cli.exe"
  if (Test-Path $wcli) { Ok $wcli }
  else {
    $rel = Invoke-RestMethod "https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest"
    $asset = $rel.assets | Where-Object { $_.name -match '^whisper-bin-x64\.zip$' } | Select-Object -First 1
    if (-not $asset) { $asset = $rel.assets | Where-Object { $_.name -match 'bin-x64\.zip$' -and $_.name -notmatch 'cublas|cuda' } | Select-Object -First 1 }
    if (-not $asset) { throw "whisper.cpp 릴리스에서 Windows zip을 찾지 못했습니다: $($rel.html_url)" }
    $zip = Join-Path $env:TEMP $asset.name
    Invoke-WebRequest -UseBasicParsing $asset.browser_download_url -OutFile $zip
    New-Item -ItemType Directory -Force -Path $wdir | Out-Null
    Expand-Archive -Force $zip $wdir
    # zip 안 구조가 바뀌어도 exe를 폴더 최상위로 올린다
    $found = Get-ChildItem -Recurse -Filter whisper-cli.exe $wdir | Select-Object -First 1
    if ($found -and $found.DirectoryName -ne $wdir) { Get-ChildItem $found.DirectoryName | Move-Item -Destination $wdir -Force }
    if (-not (Test-Path $wcli)) { throw "압축 해제 후 whisper-cli.exe 를 찾지 못했습니다: $wdir" }
    Ok "$($rel.tag_name) → $wcli"
  }

  Step "whisper 모델 (1.6GB)"
  $mdir = Join-Path $env:LOCALAPPDATA "whisper-models"
  $model = Join-Path $mdir "ggml-large-v3-turbo.bin"
  if (Test-Path $model) { Ok $model }
  else {
    New-Item -ItemType Directory -Force -Path $mdir | Out-Null
    Invoke-WebRequest -UseBasicParsing "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin" -OutFile $model
    Ok $model
  }
}

# ---------- 4. API 키 파일 템플릿
Step "API 키 파일"
$cfgDir = Join-Path $env:APPDATA $ConfigDir
$cfg = Join-Path $cfgDir "config.json"
if (-not (Test-Path $cfg)) {
  New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
  '{' + "`n" + '  "geminiApiKey": "",' + "`n" + '  "openaiApiKey": ""' + "`n" + '}' | Set-Content $cfg -Encoding UTF8
  Ok "템플릿 생성: $cfg  ← 여기에 키를 채우거나, Obsidian 설정 화면에서 붙여 넣으세요"
} else { Ok "이미 있음: $cfg" }

# ---------- 5. 마무리
Step "완료"
Write-Host @"
  다음 단계:
  1. Obsidian을 완전히 종료하고 다시 열기
  2. 설정 → Community plugins → $PluginId 가 켜져 있는지 확인
  3. 설정 → $PluginId → API 키에 OpenAI / Gemini 키 입력 (또는 $cfg 편집) → '연결 확인'
  4. 설정 → 전사 → '환경 점검' 으로 whisper·ffmpeg·모델 확인
"@
