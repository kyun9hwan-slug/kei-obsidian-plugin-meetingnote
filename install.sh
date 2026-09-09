#!/usr/bin/env bash
# Meeting Notes Obsidian 플러그인 설치 (macOS / Linux)
# 사용: curl -fsSL https://raw.githubusercontent.com/kyun9hwan-slug/kei-obsidian-plugin-meetingnote/main/install.sh | bash -s -- [--vault PATH] [--skip-whisper]
set -euo pipefail
REPO="kyun9hwan-slug/kei-obsidian-plugin-meetingnote"; PLUGIN_ID="meeting-notes"; CFG_DIR="obsidian-meeting-notes"
VAULT=""; SKIP_WHISPER=0
while [ $# -gt 0 ]; do case "$1" in
  --vault) VAULT="$2"; shift 2;; --skip-whisper) SKIP_WHISPER=1; shift;; *) echo "알 수 없는 옵션: $1"; exit 2;; esac; done
step(){ printf '\n\033[36m== %s\033[0m\n' "$1"; }; ok(){ printf '   \033[32mOK\033[0m  %s\n' "$1"; }; warn(){ printf '   \033[33m!!\033[0m  %s\n' "$1"; }

step "Obsidian 볼트"
if [ -z "$VAULT" ]; then
  REG="$HOME/Library/Application Support/obsidian/obsidian.json"; [ -f "$REG" ] || REG="$HOME/.config/obsidian/obsidian.json"
  if [ -f "$REG" ]; then
    mapfile -t VAULTS < <(python3 -c 'import json,sys;[print(v["path"]) for v in json.load(open(sys.argv[1]))["vaults"].values()]' "$REG")
    if [ "${#VAULTS[@]}" -eq 1 ]; then VAULT="${VAULTS[0]}"
    elif [ "${#VAULTS[@]}" -gt 1 ]; then echo "   볼트가 여러 개입니다. --vault 로 지정하세요:"; printf '     %s\n' "${VAULTS[@]}"; exit 2; fi
  fi
fi
[ -n "$VAULT" ] && [ -d "$VAULT" ] || { echo "   볼트를 찾지 못했습니다. --vault /path/to/vault 로 지정하세요."; exit 2; }
ok "$VAULT"

step "플러그인 파일 ($PLUGIN_ID)"
DST="$VAULT/.obsidian/plugins/$PLUGIN_ID"; mkdir -p "$DST"
for f in main.js manifest.json styles.css; do curl -fsSL "https://github.com/$REPO/releases/latest/download/$f" -o "$DST/$f"; done
ok "버전 $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$DST/manifest.json") → $DST"
CP="$VAULT/.obsidian/community-plugins.json"
python3 - "$CP" "$PLUGIN_ID" <<'PY'
import json,sys,os
p,pid=sys.argv[1],sys.argv[2]; lst=json.load(open(p)) if os.path.exists(p) else []
if pid not in lst: lst.append(pid); json.dump(lst,open(p,'w'),ensure_ascii=False,indent=2); print("   OK  community-plugins.json 에 등록")
else: print("   OK  이미 등록됨")
PY
pgrep -xq Obsidian && warn "Obsidian이 실행 중입니다. 설치 후 완전히 종료하고 다시 여세요." || true

if [ "$SKIP_WHISPER" -eq 0 ]; then
  step "ffmpeg / whisper.cpp"
  if [ "$(uname)" = "Darwin" ]; then
    command -v brew >/dev/null || { echo "   Homebrew가 필요합니다: https://brew.sh"; exit 2; }
    for pkg in ffmpeg whisper-cpp; do brew list "$pkg" >/dev/null 2>&1 && ok "$pkg 있음" || { brew install "$pkg"; ok "$pkg 설치"; }; done
  else
    command -v ffmpeg >/dev/null && ok "ffmpeg 있음" || warn "ffmpeg 을 배포판 패키지로 설치하세요 (apt install ffmpeg)"
    command -v whisper-cli >/dev/null && ok "whisper-cli 있음" || warn "whisper.cpp 를 빌드해 whisper-cli 를 PATH 에 두세요: https://github.com/ggml-org/whisper.cpp"
  fi
  step "whisper 모델 (1.6GB)"
  MDIR="$HOME/.local/share/whisper-models"; MODEL="$MDIR/ggml-large-v3-turbo.bin"
  [ -f "$MODEL" ] && ok "$MODEL" || { mkdir -p "$MDIR"; curl -fL --progress-bar -o "$MODEL" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin; ok "$MODEL"; }
fi

step "API 키 파일"
CFG="$HOME/.config/$CFG_DIR/config.json"
if [ ! -f "$CFG" ]; then mkdir -p "$(dirname "$CFG")"; chmod 700 "$(dirname "$CFG")"
  printf '{\n  "geminiApiKey": "",\n  "openaiApiKey": ""\n}\n' > "$CFG"; chmod 600 "$CFG"; ok "템플릿 생성: $CFG"
else ok "이미 있음: $CFG"; fi

step "완료"
cat <<TXT
  다음 단계:
  1. Obsidian을 완전히 종료하고 다시 열기
  2. 설정 → Community plugins → $PLUGIN_ID 가 켜져 있는지 확인
  3. 설정 → $PLUGIN_ID → API 키에 OpenAI / Gemini 키 입력 (또는 $CFG 편집) → '연결 확인'
  4. 설정 → 전사 → '환경 점검'
TXT
