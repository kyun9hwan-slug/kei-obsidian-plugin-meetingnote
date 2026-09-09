# Meeting Notes

회의를 녹음해 전사하고, 회의 전에 써 둔 아젠다·메모·첨부 문서와 대조해 **요약 / 아젠다 요약 / 상세 / 액션 아이템 / 우려되는 리스크**로 정리하는 Obsidian 플러그인.
[Lecture Notes](https://github.com/kyun9hwan-slug/obsidian-plugin-lecture)와 같은 파이프라인을 회의용으로 바꾼 것이다.

## 설치

**요구 사항**: macOS 또는 Windows (데스크톱 전용), Obsidian 1.5 이상. 로컬 전사를 쓰려면 whisper.cpp와 ffmpeg (아래 참고).

- **BRAT**: *Add Beta plugin* → `kyun9hwan-slug/kei-obsidian-plugin-meetingnote`
- **수동**: [Releases](https://github.com/kyun9hwan-slug/kei-obsidian-plugin-meetingnote/releases)에서 `main.js` `manifest.json` `styles.css`를 받아 `.obsidian/plugins/meeting-notes/`에 넣기

## 첫 설정

### API 키

설정 → **API 키**. 칸에 붙여 넣거나(볼트 안 `data.json`에 저장, 동기화 시 주의) 볼트 밖 키 파일(`~/.config/obsidian-meeting-notes/config.json`, 권장)을 쓴다. 이름 앞의 ✅/❌로 인식 여부를, **연결 확인** 버튼으로 실제 동작 여부를 본다.

- **OpenAI 키** — 요약(`gpt-5.6-luna` / `terra` / `sol` 중 선택)과 자료 대조
- **Gemini 키** — 화자 분리 전사, 한·영 복합 전사. OpenAI 키가 없을 때 요약 대체

### 전사 엔진 — 화자 구분이 중요하면 API를 쓰세요

| 엔진 | 비용 | 화자 구분 | 한·영 복합 |
|---|---|---|---|
| 로컬 whisper.cpp | 무료 | ❌ | ❌ 한 언어만 인식 |
| **Gemini API** | 분당 ~$0.005 | ✅ "화자 1: …" | ✅ |
| OpenAI API | 분당 ~$0.0045 | ❌ | 제한적 |

> 여러 명이 번갈아 말하는 회의, 혹은 한국어와 영어가 섞이는 회의라면 **Gemini API**를 권장한다.
> whisper는 발언자를 나누지 않고, 복합 언어에서는 한 언어만 잡는다(실측: 영어 발언 전부 누락).
> 회의 언어를 "한·영 복합"으로 두면 Gemini 키가 있을 때 자동으로 Gemini로 전사한다.

로컬 whisper 준비:
```bash
brew install whisper-cpp ffmpeg
mkdir -p ~/.local/share/whisper-models
curl -L -o ~/.local/share/whisper-models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin   # 1.6GB
```


### Windows

macOS와 같은 코드가 그대로 돈다. 다른 것은 로컬 whisper 준비 방법과 키 파일 위치뿐이다.

```powershell
# ffmpeg
winget install Gyan.FFmpeg          # 설치 후 Obsidian 재시작 (PATH 반영)

# whisper.cpp — 릴리스에서 Windows 바이너리를 받는다
# https://github.com/ggml-org/whisper.cpp/releases  →  whisper-bin-x64.zip
# 압축을 풀고 whisper-cli.exe 위치를 기억해 둔다 (예: C:\whisper-cpp\whisper-cli.exe)

# 모델
mkdir "$env:LOCALAPPDATA\whisper-models"
curl -L -o "$env:LOCALAPPDATA\whisper-models\ggml-large-v3-turbo.bin" `
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

설정 → 전사에서 **whisper 실행 파일**에 `whisper-cli.exe`의 전체 경로를 넣고 **환경 점검**을 누른다.
PATH나 흔한 설치 폴더(`%LOCALAPPDATA%\whisper-cpp`, `C:\ffmpeg\bin` 등)에 있으면 이름만으로도 찾는다.

- 키 파일 위치: `%APPDATA%\obsidian-meeting-notes\config.json`
- 절전 차단: PowerShell `SetThreadExecutionState`를 녹음 중에만 띄운다 (macOS의 `caffeinate`에 해당)
- 마이크 권한: Windows 설정 → 개인 정보 및 보안 → 마이크 → 데스크톱 앱 허용
- 성능: CPU 빌드 기준 M-시리즈 맥보다 느리다. 90분 회의에 5~15분 정도 잡으면 된다. NVIDIA GPU가 있으면 릴리스의 CUDA 빌드(`whisper-cublas-…zip`)가 훨씬 빠르다.

### 회의 언어

우측 패널의 **녹음 시작 버튼 바로 아래**에서 한국어 / 영어 / 한·영 복합을 고른다. 전사 엔진에 그대로 전달돼 인식률이 달라진다.

## 사용

1. 회의 노트를 열어 둔다 — 아젠다, 참석자, 확인할 질문, 첨부 문서(`![[자료.pdf]]`)를 미리 적어 두면 요약이 그것을 기준으로 대조·보완한다
2. 패널 → 회의 언어 선택 → **녹음 시작**
3. 끝나면 **정지하고 노트 만들기** → 그 노트 맨 아래에 정리가 붙는다

### 출력 형식

```markdown
## 📝 회의 정리 — 2026-09-09

## 요약               결정된 것 / 미결 구분, 3~5줄
## 아젠다 요약         안건 순서대로 결론 한 줄씩
## 상세               안건별 논의 흐름, 발언자 표시 "— 이름"
## 액션 아이템         - [ ] 담당자 — 할 일 (기한)      ← 없으면 생략
## 우려되는 리스크      일정·자원·의존성·품질            ← 없으면 생략
## 대조 결과           사전 자료와 회의가 다른 부분       ← 자료 있을 때만
## 다루지 않은 아젠다   자료엔 있는데 회의에서 안 다룬 것   ← 자료 있을 때만
```

액션 아이템은 Obsidian 체크박스라 Tasks 플러그인과 바로 연동된다.

## 동작 메모

- 오디오는 **전사 전에** 볼트에 먼저 저장한다. 실패해도 원본은 남고 `~/Downloads/meeting-notes-rescue/`가 최후 수단이다.
- Gemini 화자 분리는 **단어 타임스탬프를 같이 켜야만** 화자 주석이 온다. 주석의 인덱스는 바이트 오프셋이라 한글에서 어긋나므로 주석 안의 단어 텍스트를 이어 붙여 "화자 N:"으로 만든다.
- 화자 분리·복합 언어는 Gemini에서 파트당 30분 한도가 있어 파트 길이 기본값을 25분으로 잡았다.
- 이전에 붙인 `📝 회의 정리` 블록은 자료로 다시 읽지 않는다.
- API 키는 오류 메시지에서 마스킹된다.

## 수정 후 반영

빌드 단계가 없다. `main.js`를 고치고 `Cmd+P → Reload app without saving`.
