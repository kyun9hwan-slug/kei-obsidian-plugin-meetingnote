# AGENTS.md — AI 에이전트를 위한 설치 안내

> For AI coding agents (Claude Code, Cursor, Codex, etc.) asked to install this plugin.
> Follow the steps below literally. Ask the user only for the two things you cannot know: the vault path (if several) and API keys.

이 저장소는 **Meeting Notes** Obsidian 플러그인입니다. 사용자가 "이거 설치해 줘"라고 하면 아래 순서대로 하세요.

## 0. 먼저 확인할 것

- OS: `uname` (macOS/Linux) 또는 `$env:OS` (Windows)
- Obsidian 볼트가 하나인지 여럿인지. 설치 스크립트가 자동으로 찾지만, 여럿이면 스크립트가 목록을 출력하고 멈추니 **사용자에게 어느 볼트인지 물어보세요.**
- 로컬 전사(whisper, 무료)를 쓸지 API 전사만 쓸지. 모르면 로컬 전사 포함으로 진행하세요(모델 1.6GB 다운로드).

## 1. 설치 스크립트 실행

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/kyun9hwan-slug/kei-obsidian-plugin-meetingnote/main/install.ps1 | iex
# 볼트가 여럿이면:
# & ([scriptblock]::Create((irm https://raw.githubusercontent.com/kyun9hwan-slug/kei-obsidian-plugin-meetingnote/main/install.ps1))) -Vault "C:\path\to\vault"
```

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/kyun9hwan-slug/kei-obsidian-plugin-meetingnote/main/install.sh | bash
# 볼트가 여럿이면:
# curl -fsSL https://raw.githubusercontent.com/kyun9hwan-slug/kei-obsidian-plugin-meetingnote/main/install.sh | bash -s -- --vault "/path/to/vault"
```

스크립트가 하는 일: 플러그인 파일 3개를 `.obsidian/plugins/meeting-notes/`에 넣고 활성화 목록에 등록, ffmpeg·whisper.cpp·모델 준비, API 키 파일 템플릿 생성. 여러 번 실행해도 안전합니다.

## 2. API 키 — 반드시 사용자에게 물어보세요

키는 스크립트가 만든 파일에 넣거나 Obsidian 설정 화면에서 붙여 넣습니다.

- Windows: `%APPDATA%\obsidian-meeting-notes\config.json`
- macOS/Linux: `~/.config/obsidian-meeting-notes/config.json`

```json
{ "geminiApiKey": "…", "openaiApiKey": "…" }
```

- **OpenAI 키** (https://platform.openai.com/api-keys) — 요약에 필요
- **Gemini 키** (https://aistudio.google.com/apikey) — 화자 분리·복합 언어 전사, OpenAI 키가 없을 때 요약 대체
- 둘 중 하나만 있어도 동작합니다.

**키 값을 채팅에 다시 출력하거나 로그에 남기지 마세요.** 파일에 쓰고 "채웠다"고만 알리세요. 사용자가 키를 채팅에 붙여 넣으면 그대로 파일에 쓰고, 볼트가 Git/iCloud로 동기화되는지 물어본 뒤 동기화된다면 설정 화면이 아닌 **키 파일** 쪽을 권하세요.

## 3. Obsidian에서 확인

1. Obsidian을 **완전히 종료**하고 다시 엽니다 (플러그인 목록·PATH 반영)
2. 설정 → Community plugins → `meeting-notes` 켜짐 확인. Restricted mode가 켜져 있으면 끄라고 안내
3. 설정 → Meeting Notes → **API 키** 항목이 ✅인지, **연결 확인** 버튼이 성공하는지
4. 설정 → 전사 → **환경 점검** 버튼: whisper·ffmpeg·모델이 모두 ✅ 여야 함
5. 첫 녹음: 노트 하나를 열어 두고 우측 패널 → 녹음 시작 → OS 마이크 권한 허용 → 30초 말하고 정지

## 4. 흔한 문제

| 증상 | 조치 |
|---|---|
| Windows에서 `ffmpeg을 찾을 수 없습니다` | winget 설치 직후라 PATH 미반영. Obsidian 재시작 |
| `whisper 실행 파일을 찾을 수 없습니다` | 설정 → 전사 → whisper 실행 파일에 `whisper-cli.exe` 전체 경로 입력 (`%LOCALAPPDATA%\whisper-cpp\whisper-cli.exe`) |
| 마이크 권한 오류 | Windows: 설정 → 개인 정보 → 마이크 → 데스크톱 앱 허용 / macOS: 개인정보 보호 → 마이크 → Obsidian |
| 플러그인이 목록에 없음 | Community plugins 옆 새로고침(↻) 또는 Obsidian 재시작 |
| 한·영 섞인 회의에서 영어가 빠짐 | whisper 한계. 회의 언어를 "한·영 복합"으로 두면 Gemini 키가 있을 때 자동으로 Gemini로 전사 |

## 5. 하지 말 것

- `main.js`를 수정하지 마세요. 사용자 설정은 모두 Obsidian 설정 화면 또는 `data.json`에 있습니다.
- 키 파일을 볼트 안으로 옮기지 마세요.
- 릴리스가 아닌 `main` 브랜치의 `main.js`를 받지 마세요. 스크립트는 항상 최신 릴리스를 씁니다.

## 저장소 구조

```
main.js        플러그인 전체 (빌드 없음, 그대로 로드)
manifest.json  id · version · minAppVersion
styles.css     패널·설정 UI
versions.json  버전 → 최소 Obsidian 버전
install.ps1    Windows 설치
install.sh     macOS/Linux 설치
README.md      사람용 문서
```
