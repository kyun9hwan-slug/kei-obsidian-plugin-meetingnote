'use strict';

const {
  Plugin, PluginSettingTab, Setting, Notice, Modal, ItemView,
  TFile, TFolder, normalizePath, requestUrl,
} = require('obsidian');

const VIEW_TYPE = 'meeting-notes-view';
// 파이프라인 진행률 구간 (%). 전사가 제일 오래 걸려서 가장 넓게 잡았다.
const P_CONTEXT = [2, 8];
const P_TRANSCRIBE = [8, 68];
const P_SUMMARIZE = [68, 98];

// 첨부 자료 하나당 프롬프트에 넣는 글자 수 상한. 100쪽 PDF를 통째로 넣으면 비용만 늘고 요약은 흐려진다.
const MAX_CONTEXT_PIECE = 40000;

const METER_FLOOR = -60;      // 미터 최저 표시값 (dBFS)
const PEAK_DECAY_DB = 0.4;    // 피크 홀드가 프레임마다 내려오는 양

const fs = require('fs');
const os = require('os');
const nodePath = require('path');
const { spawn } = require('child_process');
const https = require('https');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// 파일 업로드는 일반 API가 아니라 /upload/ 접두사가 붙은 미디어 엔드포인트를 쓴다.
const GEMINI_UPLOAD_BASE = 'https://generativelanguage.googleapis.com/upload/v1beta';
const OPENAI_BASE = 'https://api.openai.com/v1';
const OPENAI_MAX_BYTES = 25 * 1024 * 1024;

const MEETING_FORMAT = [
  '다음 형식의 마크다운으로 정리하세요. 해당 내용이 회의에 없으면 그 섹션은 통째로 생략하세요.',
  '',
  '## 요약',
  '## 아젠다 요약',
  '## 상세',
  '## 액션 아이템',
  '## 우려되는 리스크',
  '',
  '섹션별 지침:',
  '- 요약: 3~5줄. 결정된 것과 미결로 남은 것을 구분해서 쓰세요.',
  '- 아젠다 요약: 다룬 안건을 순서대로, 안건마다 결론 한 줄.',
  '- 상세: 안건별로 논의 흐름·근거·반대 의견. 발언자가 구분되면 문장 끝에 "— 이름"으로 출처를 남기세요.',
  '- 액션 아이템: `- [ ] 담당자 — 할 일 (기한)` 체크박스 형식. 담당자나 기한이 언급되지 않았으면 (담당 미정) / (기한 미정)으로 표시. 하나도 없으면 섹션을 만들지 마세요.',
  '- 우려되는 리스크: 일정·자원·의존성·품질 리스크와 회의에서 나온 대응 방안. 없으면 섹션을 만들지 마세요.',
  '',
  '규칙:',
  '- 회의에서 실제로 나온 내용만 쓰세요. 일반 상식으로 빈칸을 채우지 마세요.',
  '- 숫자·날짜·금액·이름은 바꾸지 말고 그대로 인용하세요.',
  '- "화자 1", "화자 2" 같은 표시가 있으면 발언 주체를 구분하고, 대화 중 이름이 드러나면 그 이름으로 바꿔 쓰세요.',
  '- 최상위 헤딩(#)은 쓰지 말고 ## 부터 시작하세요.',
  '- 전체를 코드블록으로 감싸지 마세요.',
];

const DEFAULT_PROMPT = [
  '당신은 회의록을 정리하는 실무 비서입니다.',
  '"{{course}}" 프로젝트의 "{{title}}" 회의({{date}}, {{duration}})를 자동 전사한 텍스트입니다.',
  '자동 전사라서 오탈자와 잘못 인식된 이름·용어가 섞여 있습니다. 문맥으로 바로잡되, 확신이 없으면 원문을 남기고 뒤에 (?)를 붙이세요.',
  '',
  ...MEETING_FORMAT,
  '',
  '전사문:',
  '---',
  '{{transcript}}',
  '---',
].join('\n');

const DEFAULT_CONTEXT_PROMPT = [
  '당신은 회의록을 정리하는 실무 비서입니다.',
  '"{{course}}" 프로젝트의 "{{title}}" 회의({{date}}, {{duration}}) 정리입니다.',
  '',
  '자료가 두 종류 주어집니다.',
  '1) [자료] — 회의 전에 작성된 아젠다·메모와 첨부 문서. 이름·용어·수치의 표기가 정확한 원본입니다.',
  '2) [전사] — 회의 녹음을 자동 전사한 텍스트. 오탈자와 잘못 인식된 이름·용어가 섞여 있습니다.',
  '',
  '대조 작업:',
  '- [전사]의 잘못 인식된 이름·용어·수치를 [자료]의 표기로 바로잡으세요.',
  '- [자료]의 아젠다 항목 하나하나에 대해 회의에서 다뤄졌는지 확인하고, 다뤄진 것은 결론을, 안 다뤄진 것은 "다루지 않은 아젠다"에 모으세요.',
  '- [자료]에 적힌 질문이나 확인 사항에 회의에서 답이 나왔으면 그 답을 명시하세요.',
  '- [자료]의 수치·일정과 [전사]의 발언이 어긋나면 양쪽을 병기하고 "대조 결과"에 적으세요.',
  '- [전사]에만 있는 내용(즉석 결정, 새 이슈, 우려 발언)을 반드시 살리세요. 녹음의 핵심 가치입니다.',
  '',
  ...MEETING_FORMAT.map((line) => (line === '## 우려되는 리스크'
    ? '## 우려되는 리스크\n## 대조 결과 (자료와 회의가 다른 부분)\n## 다루지 않은 아젠다'
    : line)),
  '- 대조 결과·다루지 않은 아젠다도 해당 내용이 없으면 섹션을 만들지 마세요.',
  '',
  '[자료]',
  '---',
  '{{context}}',
  '---',
  '',
  '[전사]',
  '---',
  '{{transcript}}',
  '---',
].join('\n');

const DEFAULT_SETTINGS = {
  // 전사: 'whisper'(로컬·무료·화자 구분 없음) | 'gemini'(API·화자 구분) | 'openai'(API)
  sttEngine: 'whisper',
  whisperBinary: '/opt/homebrew/bin/whisper-cli',
  whisperModel: '~/.local/share/whisper-models/ggml-large-v3-turbo.bin',
  ffmpegBinary: '/opt/homebrew/bin/ffmpeg',
  whisperThreads: 0,
  whisperTermPrompt: true,
  // 회의 언어: 'ko' | 'en' | 'mixed'. 사이드바에서 녹음 직전에 바꾼다.
  spokenLanguage: 'ko',
  configPath: '~/.config/obsidian-meeting-notes/config.json',
  geminiApiKey: '',
  openaiApiKey: '',
  geminiSttModel: 'gemini-3.5-transcribe',
  openaiSttModel: 'gpt-transcribe',
  // 요약은 OpenAI luna / terra / sol 중 선택. OpenAI 키가 없으면 Gemini로 대신한다.
  summaryModel: 'gpt-5.6-sol',
  geminiFallbackModel: 'gemini-3.8-flash',
  useContextModel: true,
  contextModel: 'gpt-5.6-sol',
  contextEffort: 'high',
  audioLocation: 'noteFolder',
  audioFolder: 'Meetings/Audio',
  noteFolder: 'Meetings',
  inputDeviceId: '',
  // Gemini 화자 분리는 파트당 30분 한도. 여유를 두고 25분에서 끊는다.
  chunkMinutes: 25,
  audioBitrate: 32000,
  diarization: true,
  wordTimestamps: false,
  saveTranscript: false,
  keepAwake: true,
  titleSource: 'activeNote',
  summaryTarget: 'append',
  contextPrompt: DEFAULT_CONTEXT_PROMPT,
  audioNameTemplate: '{{stamp}} {{course}} {{title}}',
  summaryPrompt: DEFAULT_PROMPT,
};

const SUMMARY_MODELS = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'];

/** 회의 언어 설정을 각 엔진이 받는 형식으로 바꾼다. */
function languageProfile(spoken) {
  switch (spoken) {
    case 'en': return { label: '영어', whisper: 'en', gemini: ['en-US'], openai: 'en' };
    case 'mixed': return { label: '한·영 복합', whisper: 'auto', gemini: [], openai: null };
    default: return { label: '한국어', whisper: 'ko', gemini: ['ko-KR'], openai: 'ko' };
  }
}

/** 사용자에게 그대로 보여줘도 되는(=키가 섞이지 않은) 오류. */
class LectureError extends Error {}

// ---------------------------------------------------------------- 유틸

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? nodePath.join(os.homedir(), p.slice(1)) : p;
}

const pad = (n) => String(n).padStart(2, '0');

function stampOf(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function humanDuration(ms) {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`;
}

/** 볼트 경로에 못 들어가는 문자를 제거한다. */
function sanitize(name) {
  const cleaned = String(name || '').replace(/[\\/:*?"<>|#^[\]]/g, '').trim();
  return cleaned || '무제';
}

/** API 오류 본문에 키가 그대로 실려 오는 경우가 있어 마스킹한다. */
function redact(text) {
  return String(text || '').replace(/\b(AIza[\w-]{10,}|sk-[\w-]{10,})\b/g, '***');
}

/** 응답 헤더를 대소문자 구분 없이 찾는다. */
function headerOf(headers, name) {
  if (!headers) return '';
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) return headers[k];
  }
  return '';
}

function apiError(what, res) {
  let detail = '';
  try {
    detail = res.json?.error?.message || res.json?.message || '';
  } catch (_) { /* 본문이 JSON이 아닌 경우 */ }
  if (!detail) detail = (res.text || '').slice(0, 400);
  return new LectureError(`${what} 실패 (HTTP ${res.status})\n${redact(detail)}`);
}

/**
 * multipart/form-data 본문을 ArrayBuffer로 조립한다.
 * requestUrl은 FormData를 받지 못해서 직접 만들어야 한다.
 * fields: [{name, value}] 또는 [{name, filename, contentType, data:Uint8Array}]
 */
function buildMultipart(fields) {
  const boundary = `----ObsidianMeetingNotes${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const enc = new TextEncoder();
  const segs = [];
  for (const f of fields) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"`;
    if (f.filename) head += `; filename="${f.filename}"`;
    head += '\r\n';
    if (f.contentType) head += `Content-Type: ${f.contentType}\r\n`;
    segs.push(enc.encode(`${head}\r\n`));
    segs.push(f.data ? f.data : enc.encode(String(f.value)));
    segs.push(enc.encode('\r\n'));
  }
  segs.push(enc.encode(`--${boundary}--\r\n`));

  const total = segs.reduce((n, s) => n + s.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const s of segs) { out.set(s, off); off += s.byteLength; }
  return { body: out.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}

// ---------------------------------------------------------------- 키 저장소

/**
 * API 키를 두 곳에서 찾는다. 설정(data.json)에 붙여 넣은 값이 있으면 그것을, 없으면 볼트 밖 키 파일을 쓴다.
 * 키 파일이 안전한 방식이다. 설정에 넣으면 볼트가 동기화될 때 키도 함께 올라간다.
 */
class KeyStore {
  constructor(plugin) { this.plugin = plugin; }

  get path() { return expandHome(this.plugin.settings.configPath); }

  static field(provider) { return provider === 'gemini' ? 'geminiApiKey' : 'openaiApiKey'; }

  /** 키 파일을 읽는다. 없거나 깨졌으면 null. */
  readFile() {
    const p = this.path;
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  /** 키와 출처를 돌려준다. 값을 로그에 남기지 않도록 이 메서드 밖으로는 key만 흘려보낸다. */
  lookup(provider) {
    const field = KeyStore.field(provider);
    const fromSettings = String(this.plugin.settings[field] || '').trim();
    if (fromSettings) return { key: fromSettings, source: 'settings' };
    const cfg = this.readFile();
    const fromFile = cfg ? String(cfg[field] || '').trim() : '';
    if (fromFile) return { key: fromFile, source: 'file' };
    return { key: '', source: null };
  }

  get(provider) {
    const found = this.lookup(provider);
    if (!found.key) {
      const label = provider === 'gemini' ? 'Gemini' : 'OpenAI';
      throw new LectureError(
        `${label} API 키가 없습니다.\n설정 → API 키 칸에 붙여 넣거나, 키 파일에 채우세요: ${this.path}`,
      );
    }
    return found.key;
  }

  /** 값은 절대 반환하지 않고 존재 여부와 출처만 알려준다 (설정 화면·사전 점검용). */
  status() {
    const g = this.lookup('gemini');
    const o = this.lookup('openai');
    return {
      exists: fs.existsSync(this.path),
      gemini: Boolean(g.key),
      openai: Boolean(o.key),
      geminiSource: g.source,
      openaiSource: o.source,
    };
  }

  /** 템플릿 파일을 만들고 소유자만 읽을 수 있게 잠근다. */
  scaffold() {
    const p = this.path;
    fs.mkdirSync(nodePath.dirname(p), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, `${JSON.stringify({ geminiApiKey: '', openaiApiKey: '' }, null, 2)}\n`, { mode: 0o600 });
    }
    fs.chmodSync(p, 0o600);
    return p;
  }
}

// ---------------------------------------------------------------- 제공자

class GeminiProvider {
  constructor(plugin) { this.plugin = plugin; }

  get name() { return 'Gemini'; }
  headers(key, extra) { return Object.assign({ 'x-goog-api-key': key }, extra || {}); }

  /**
   * Files API 업로드. 2단계 resumable 프로토콜이다.
   * 1) /upload/v1beta/files 에 start 명령 → 응답 헤더로 업로드 전용 URL을 받는다
   * 2) 그 URL로 바이트를 보내며 finalize → 파일 메타데이터(uri)를 받는다
   */
  async upload(key, bytes, filename, mime) {
    const size = bytes.byteLength;

    const start = await requestUrl({
      url: `${GEMINI_UPLOAD_BASE}/files`,
      method: 'POST',
      headers: this.headers(key, {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(size),
        'X-Goog-Upload-Header-Content-Type': mime,
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ file: { display_name: filename } }),
      throw: false,
    });
    if (start.status >= 300) throw apiError('Gemini 업로드 세션 시작', start);

    const uploadUrl = headerOf(start.headers, 'x-goog-upload-url');
    if (!uploadUrl) {
      throw new LectureError(
        'Gemini가 업로드 URL을 돌려주지 않았습니다.\n' +
        `응답 헤더: ${Object.keys(start.headers || {}).join(', ') || '(없음)'}`,
      );
    }

    const finish = await requestUrl({
      url: uploadUrl,
      method: 'POST',
      headers: {
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + size),
      throw: false,
    });
    if (finish.status >= 300) throw apiError('Gemini 파일 업로드', finish);

    const file = finish.json?.file || finish.json || {};
    if (!file.uri) {
      throw new LectureError(
        `Gemini 업로드 응답에 파일 URI가 없습니다 (HTTP ${finish.status}).\n` +
        `응답 본문: ${redact((finish.text || '(비어 있음)').slice(0, 300))}`,
      );
    }
    return { uri: file.uri, name: file.name, state: file.state };
  }

  /** 업로드 직후 PROCESSING 상태일 수 있어 ACTIVE가 될 때까지 기다린다. */
  async waitActive(key, file) {
    if (!file.name || file.state === 'ACTIVE') return;
    for (let i = 0; i < 60; i++) {
      const res = await requestUrl({
        url: `${GEMINI_BASE}/${file.name}`,
        headers: this.headers(key),
        throw: false,
      });
      if (res.status >= 300) return; // 상태 조회가 막혀도 전사는 시도해 본다
      const state = res.json?.state || res.json?.file?.state;
      if (!state || state === 'ACTIVE') return;
      if (state === 'FAILED') throw new LectureError('Gemini가 오디오 파일 처리에 실패했습니다.');
      await sleep(2000);
    }
  }

  async transcribe(key, part, onProgress) {
    onProgress('업로드 중', 0.05);
    const file = await this.upload(key, part.bytes, part.filename, part.mime);
    await this.waitActive(key, file);
    onProgress('업로드 완료', 0.4);

    const s = this.plugin.settings;
    const lang = languageProfile(s.spokenLanguage);
    const mode = { type: 'verbatim' };
    if (s.diarization) mode.diarization_mode = 'speaker';
    // 화자 주석은 단어 타임스탬프를 함께 켜야만 돌아온다 (실측: 없으면 주석 0개).
    // 한·영 복합도 타임스탬프 없이는 영어 발언이 통째로 빠졌다. 둘 다 파트당 30분 한도가 생긴다.
    if (s.diarization || s.wordTimestamps || s.spokenLanguage === 'mixed') {
      mode.timestamp_granularities = ['word'];
    }

    const payload = {
      model: s.geminiSttModel,
      input: [{ type: 'audio', uri: file.uri, mime_type: part.mime }],
      generation_config: {
        transcription_config: { language_codes: lang.gemini, mode },
      },
    };

    onProgress('전사 중', 0.45);
    const res = await requestUrl({
      url: `${GEMINI_BASE}/interactions`,
      method: 'POST',
      headers: this.headers(key, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
      throw: false,
    });
    if (res.status >= 300) throw apiError('Gemini 전사', res);

    let job = res.json;
    for (let i = 0; job?.status && job.status !== 'completed' && i < 400; i++) {
      if (job.status === 'failed') {
        throw new LectureError(`Gemini 전사 실패: ${redact(job.error?.message || '알 수 없는 오류')}`);
      }
      // 폴링 구간은 남은 시간을 알 수 없어 0.95에 점근하게 둔다.
      onProgress(`전사 중 ${i * 3}초 경과`, 0.45 + 0.5 * (1 - Math.exp(-i / 8)));
      await sleep(3000);
      const poll = await requestUrl({
        url: `${GEMINI_BASE}/${job.id}`,
        headers: this.headers(key),
        throw: false,
      });
      if (poll.status >= 300) throw apiError('Gemini 전사 상태 조회', poll);
      job = poll.json;
    }

    const text = job?.output_text || this.textFromSteps(job);
    if (!text) throw new LectureError('Gemini 응답에서 전사문을 찾지 못했습니다.');
    return text.trim();
  }

  /**
   * 실제 응답에는 문서에 적힌 output_text가 없고 steps 안에만 텍스트가 있다.
   * 사고 과정 같은 다른 단계가 섞여 와도 전사문만 골라내도록 model_output을 우선한다.
   */
  textFromSteps(job) {
    const steps = job?.steps || [];
    const outputs = steps.filter((s) => s.type === 'model_output');
    return (outputs.length ? outputs : steps)
      .flatMap((s) => s.content || [])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => renderSpeakers(c.text, c.annotations))
      .join('\n')
      .trim();
  }

  async complete(key, prompt) {
    const res = await requestUrl({
      url: `${GEMINI_BASE}/models/${this.plugin.settings.geminiFallbackModel}:generateContent`,
      method: 'POST',
      headers: this.headers(key, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
      throw: false,
    });
    if (res.status >= 300) throw apiError('Gemini 요약', res);
    const parts = res.json?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text).filter(Boolean).join('').trim();
    if (!text) throw new LectureError('Gemini 요약 응답이 비어 있습니다.');
    return text;
  }

  /** 스트리밍 요약. onDelta로 지금까지 받은 전체 텍스트를 넘겨 진행률을 만든다. */
  async completeStream(key, prompt, onDelta, opts) {
    const model = (opts && opts.model) || this.plugin.settings.geminiFallbackModel;
    const text = await streamPost({
      url: `${GEMINI_BASE}/models/${model}:streamGenerateContent?alt=sse`,
      headers: this.headers(key, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
      parseLine: parseGeminiSse,
      onDelta,
    });
    if (!text) throw new LectureError('Gemini 요약 응답이 비어 있습니다.');
    return text;
  }

  async listModels(key) {
    const res = await requestUrl({ url: `${GEMINI_BASE}/models?pageSize=200`, headers: this.headers(key), throw: false });
    if (res.status >= 300) throw apiError('Gemini 모델 목록', res);
    return (res.json?.models || []).map((m) => String(m.name).replace(/^models\//, '')).sort();
  }
}

class OpenAIProvider {
  constructor(plugin) { this.plugin = plugin; }

  get name() { return 'OpenAI'; }
  headers(key, extra) { return Object.assign({ Authorization: `Bearer ${key}` }, extra || {}); }

  async transcribe(key, part, onProgress) {
    if (part.bytes.byteLength > OPENAI_MAX_BYTES) {
      const mb = (part.bytes.byteLength / 1024 / 1024).toFixed(1);
      throw new LectureError(
        `${part.filename}이(가) ${mb}MB로 OpenAI 업로드 한도(25MB)를 넘습니다.\n` +
        '설정에서 청크 길이나 비트레이트를 줄이거나 Gemini로 전환하세요.',
      );
    }

    const s = this.plugin.settings;
    const fields = [
      { name: 'file', filename: part.filename, contentType: part.mime, data: part.bytes },
      { name: 'model', value: s.openaiSttModel },
      { name: 'response_format', value: 'json' },
    ];
    const lang = languageProfile(s.spokenLanguage);
    if (lang.openai) fields.push({ name: 'language', value: lang.openai });

    onProgress('업로드 및 전사 중', 0.25);
    const { body, contentType } = buildMultipart(fields);
    const res = await requestUrl({
      url: `${OPENAI_BASE}/audio/transcriptions`,
      method: 'POST',
      headers: this.headers(key, { 'Content-Type': contentType }),
      body,
      throw: false,
    });
    if (res.status >= 300) throw apiError('OpenAI 전사', res);

    let text = '';
    try { text = res.json?.text || ''; } catch (_) { /* text 응답일 수 있다 */ }
    if (!text) text = (res.text || '').trim();
    if (!text) throw new LectureError('OpenAI 응답에서 전사문을 찾지 못했습니다.');
    return text.trim();
  }

  async complete(key, prompt) {
    const res = await requestUrl({
      url: `${OPENAI_BASE}/chat/completions`,
      method: 'POST',
      headers: this.headers(key, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model: this.plugin.settings.summaryModel,
        messages: [{ role: 'user', content: prompt }],
      }),
      throw: false,
    });
    if (res.status >= 300) throw apiError('OpenAI 요약', res);
    const text = (res.json?.choices?.[0]?.message?.content || '').trim();
    if (!text) throw new LectureError('OpenAI 요약 응답이 비어 있습니다.');
    return text;
  }

  async completeStream(key, prompt, onDelta, opts) {
    const payload = {
      model: (opts && opts.model) || this.plugin.settings.summaryModel,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    };
    if (opts && opts.reasoningEffort) payload.reasoning_effort = opts.reasoningEffort;

    const text = await streamPost({
      url: `${OPENAI_BASE}/chat/completions`,
      headers: this.headers(key, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
      parseLine: parseOpenAiSse,
      onDelta,
    });
    if (!text) throw new LectureError('OpenAI 요약 응답이 비어 있습니다.');
    return text;
  }

  async listModels(key) {
    const res = await requestUrl({ url: `${OPENAI_BASE}/models`, headers: this.headers(key), throw: false });
    if (res.status >= 300) throw apiError('OpenAI 모델 목록', res);
    return (res.json?.data || []).map((m) => m.id).sort();
  }
}

// ---------------------------------------------------------------- 녹음기

/**
 * 로컬 whisper.cpp 전사. API 비용이 0이고 오디오가 맥 밖으로 나가지 않는다.
 * whisper는 16kHz 모노 WAV만 받아서 ffmpeg으로 한 번 변환한다.
 */
class WhisperProvider {
  constructor(plugin) { this.plugin = plugin; }

  get name() { return 'whisper.cpp'; }

  /** 실행 파일·모델이 준비됐는지 확인한다. */
  check() {
    const s = this.plugin.settings;
    const problems = [];
    const whisper = expandHome(s.whisperBinary);
    const ffmpeg = expandHome(s.ffmpegBinary);
    const model = expandHome(s.whisperModel);
    if (!fs.existsSync(whisper)) problems.push(`whisper 실행 파일이 없습니다: ${whisper}\n  brew install whisper-cpp`);
    if (!fs.existsSync(ffmpeg)) problems.push(`ffmpeg이 없습니다: ${ffmpeg}\n  brew install ffmpeg`);
    if (!fs.existsSync(model)) {
      problems.push(`whisper 모델 파일이 없습니다: ${model}\n  다운로드: https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${nodePath.basename(model)}`);
    }
    return problems;
  }

  async transcribe(_key, part, onProgress, opts) {
    const problems = this.check();
    if (problems.length) throw new LectureError(`로컬 전사를 쓸 수 없습니다.\n\n${problems.join('\n')}`);

    const s = this.plugin.settings;
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'meeting-notes-'));
    const source = nodePath.join(dir, `in${nodePath.extname(part.filename) || '.webm'}`);
    const wav = nodePath.join(dir, 'audio.wav');

    try {
      fs.writeFileSync(source, Buffer.from(part.bytes));

      onProgress('오디오 변환 중', 0.03);
      await runCommand(expandHome(s.ffmpegBinary),
        ['-loglevel', 'error', '-y', '-i', source, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);

      const args = [
        '-m', expandHome(s.whisperModel),
        '-f', wav,
        '-l', languageProfile(s.spokenLanguage).whisper,
        '-nt', '-pp',
        // -mc 0: 앞 구간의 텍스트를 다음 구간 컨텍스트로 넘기지 않는다.
        // 30분 실제 회의로 재보니 중복 문장 24개 → 0개, 인식 글자 수는 오히려 36% 늘었다.
        // 반복 루프가 실제 내용을 밀어내고 있었기 때문이다.
        '-mc', '0',
      ];
      if (s.whisperThreads > 0) args.push('-t', String(s.whisperThreads));
      if (opts && opts.termPrompt) args.push('--prompt', opts.termPrompt);

      onProgress('전사 중 0%', 0.1);
      let seen = 0;
      const text = await runCommand(expandHome(s.whisperBinary), args, (chunk) => {
        // whisper_print_progress_callback: progress =  42%
        const matches = chunk.match(/progress\s*=\s*(\d+)%/g);
        if (!matches) return;
        const pct = Number(matches[matches.length - 1].match(/(\d+)%/)[1]);
        if (pct <= seen) return;
        seen = pct;
        onProgress(`전사 중 ${pct}%`, 0.1 + 0.9 * (pct / 100));
      });

      const clean = text.replace(/^\s*\[[^\]]*\]\s*/gm, '').trim();
      if (!clean) throw new LectureError('whisper가 아무 말도 인식하지 못했습니다. 녹음 레벨을 확인하세요.');
      return clean;
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 임시 파일 정리 실패는 무시 */ }
    }
  }
}

/**
 * 하나의 MediaStream 위에서 MediaRecorder를 주기적으로 끊었다 다시 시작한다.
 * webm은 중간 청크만 떼어내면 단독 디코딩이 안 되므로, 파트마다 독립된 파일을 만든다.
 * 파트 경계에서 수십 ms 공백이 생기지만 회의 녹음에서는 무시할 수준이다.
 */
class Recorder {
  constructor(plugin) {
    this.plugin = plugin;
    this.active = false;
    this.paused = false;
    this.blobs = [];
    this.startedAt = 0;
    this.pausedMs = 0;
    this.pausedAt = 0;
    this.rotateTimer = null;
    this.caffeinate = null;
  }

  static pickMime() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    for (const c of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  }

  get elapsedMs() {
    if (!this.active) return 0;
    const paused = this.pausedMs + (this.paused ? Date.now() - this.pausedAt : 0);
    return Date.now() - this.startedAt - paused;
  }

  async start() {
    const s = this.plugin.settings;
    const audio = {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (s.inputDeviceId) audio.deviceId = { exact: s.inputDeviceId };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
        throw new LectureError(
          '마이크 권한이 없습니다.\n시스템 설정 → 개인정보 보호 및 보안 → 마이크에서 Obsidian을 켠 뒤 앱을 재시작하세요.',
        );
      }
      if (e && e.name === 'NotFoundError') {
        throw new LectureError('선택한 입력 장치를 찾을 수 없습니다. 설정에서 입력 장치를 다시 고르세요.');
      }
      throw new LectureError(`마이크를 열 수 없습니다: ${e.message}`);
    }

    try {
      this.attachAnalyser();
      this.mime = Recorder.pickMime();
      this.blobs = [];
      this.startedAt = Date.now();
      this.pausedMs = 0;
      this.active = true;
      this.paused = false;
      this.startPart();
      this.scheduleRotate();
    } catch (e) {
      // 여기서 실패하면 마이크가 켜진 채 남는다. 반드시 되돌린다.
      this.active = false;
      this.detachAnalyser();
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      throw new LectureError(`녹음기를 시작할 수 없습니다: ${e.message}`);
    }

    if (s.keepAwake) {
      // 녹음 도중 맥북이 잠들면 스트림이 끊긴다.
      try { this.caffeinate = spawn('caffeinate', ['-i']); } catch (_) { this.caffeinate = null; }
    }
  }

  /**
   * 레벨 미터용 분석기를 스트림에 건다.
   * destination에는 연결하지 않는다. 연결하면 회의실 스피커로 하울링이 난다.
   */
  attachAnalyser() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new Ctx();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0;
      this.levelBuf = new Float32Array(this.analyser.fftSize);
      this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);
      this.sourceNode.connect(this.analyser);
    } catch (_) {
      // 미터는 부가 기능이다. 실패해도 녹음 자체는 계속한다.
      this.analyser = null;
    }
  }

  detachAnalyser() {
    try { if (this.sourceNode) this.sourceNode.disconnect(); } catch (_) { /* 이미 해제됨 */ }
    try { if (this.audioCtx) this.audioCtx.close(); } catch (_) { /* 이미 닫힘 */ }
    this.sourceNode = null;
    this.analyser = null;
    this.audioCtx = null;
  }

  /** 현재 프레임의 피크/RMS를 dBFS로 돌려준다. 측정 불가면 null. */
  getLevels() {
    if (!this.analyser || !this.active || this.paused) return null;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let peak = 0;
    let sumSquares = 0;
    for (let i = 0; i < this.levelBuf.length; i++) {
      const v = this.levelBuf[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sumSquares += v * v;
    }
    return {
      peakDb: toDbfs(peak),
      rmsDb: toDbfs(Math.sqrt(sumSquares / this.levelBuf.length)),
    };
  }

  startPart() {
    const opts = {};
    if (this.mime) opts.mimeType = this.mime;
    if (this.plugin.settings.audioBitrate) opts.audioBitsPerSecond = this.plugin.settings.audioBitrate;

    const rec = new MediaRecorder(this.stream, opts);
    const buf = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) buf.push(e.data); };
    rec.onstop = () => {
      if (buf.length) this.blobs.push(new Blob(buf, { type: this.mime || 'audio/webm' }));
      if (this.onPartClosed) { const cb = this.onPartClosed; this.onPartClosed = null; cb(); }
    };
    rec.start();
    this.rec = rec;
  }

  stopPart() {
    return new Promise((resolve) => {
      if (!this.rec || this.rec.state === 'inactive') return resolve();
      this.onPartClosed = resolve;
      this.rec.stop();
    });
  }

  /** setInterval 대신 체이닝해서 파트 교체가 겹치지 않게 한다. */
  scheduleRotate() {
    const ms = Math.max(1, this.plugin.settings.chunkMinutes) * 60 * 1000;
    this.rotateTimer = setTimeout(async () => {
      if (!this.active) return;
      if (!this.paused) {
        await this.stopPart();
        if (!this.active) return;
        this.startPart();
      }
      this.scheduleRotate();
    }, ms);
  }

  pause() {
    if (!this.active || this.paused || !this.rec) return;
    this.rec.pause();
    this.paused = true;
    this.pausedAt = Date.now();
  }

  resume() {
    if (!this.active || !this.paused || !this.rec) return;
    this.rec.resume();
    this.pausedMs += Date.now() - this.pausedAt;
    this.paused = false;
  }

  async stop() {
    if (!this.active) return { blobs: [], durationMs: 0, mime: this.mime };
    const durationMs = this.elapsedMs;
    this.active = false;
    if (this.rotateTimer) { clearTimeout(this.rotateTimer); this.rotateTimer = null; }
    if (this.rec && this.rec.state === 'paused') this.rec.resume();
    await this.stopPart();
    this.detachAnalyser();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.caffeinate) { try { this.caffeinate.kill(); } catch (_) { /* 이미 종료 */ } this.caffeinate = null; }
    return { blobs: this.blobs, durationMs, mime: this.mime || 'audio/webm' };
  }
}

// ---------------------------------------------------------------- 모달

/** 녹음 시작 전 프로젝트과 회의 제목을 받는다. 기본값은 지금 열어 둔 노트에서 가져온다. */
class SessionModal extends Modal {
  constructor(plugin, onSubmit, labels) {
    super(plugin.app);
    this.plugin = plugin;
    this.onSubmit = onSubmit;
    this.labels = Object.assign({ heading: '회의 녹음 시작', submit: '녹음 시작' }, labels || {});
    this.course = '';
    this.title = '';
    this.titleTouched = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.labels.heading });

    const courses = this.plugin.listCourses();
    const pre = this.plugin.activeNoteContext();

    // 열어 둔 노트의 상위 폴더가 프로젝트 목록에 있으면 그것을, 없으면 새 프로젝트으로 채운다.
    if (pre.course && courses.includes(pre.course)) {
      this.course = pre.course;
    } else if (pre.course) {
      this.course = '__new__';
      this.newCourse = pre.course;
    } else {
      this.course = courses[0] || '__new__';
    }

    if (pre.title) {
      contentEl.createEl('p', {
        cls: 'meeting-notes-hint',
        text: `열어 둔 노트: ${pre.path}`,
      });
    }

    new Setting(contentEl)
      .setName('프로젝트')
      .addDropdown((d) => {
        courses.forEach((c) => d.addOption(c, c));
        d.addOption('__new__', '+ 새 프로젝트 만들기');
        d.setValue(this.course);
        d.onChange((v) => {
          this.course = v;
          newRow.settingEl.toggle(v === '__new__');
          this.suggestTitle();
        });
      });

    const newRow = new Setting(contentEl)
      .setName('새 프로젝트 이름')
      .addText((t) => {
        t.setPlaceholder('예: 신규 온보딩');
        if (this.newCourse) t.setValue(this.newCourse);
        t.onChange((v) => { this.newCourse = v; });
      });
    newRow.settingEl.toggle(this.course === '__new__');

    new Setting(contentEl)
      .setName('회의 제목')
      .setDesc('오디오 파일명과 노트 이름에 함께 쓰입니다.')
      .addText((t) => {
        this.titleInput = t;
        t.setPlaceholder('예: 주간 동기화');
        t.onChange((v) => { this.title = v; this.titleTouched = true; });
        t.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this.submit(); }
        });
      });

    // 제목 기본값을 어디서 가져올지 바로 바꿀 수 있게 한다.
    if (pre.title) {
      new Setting(contentEl)
        .setName('제목 기본값')
        .addButton((b) => b
          .setButtonText(`열어 둔 노트 제목 (${pre.title})`)
          .onClick(() => { this.titleTouched = false; this.setTitle(pre.title); }))
        .addButton((b) => b
          .setButtonText('자동 (오늘 날짜)')
          .onClick(() => { this.titleTouched = false; this.setTitle(this.autoTitle()); }));
    }

    this.suggestTitle();

    new Setting(contentEl).addButton((b) => {
      b.setButtonText(this.labels.submit).setCta().onClick(() => this.submit());
    });

    // 제목 칸에 커서를 두고 바로 고칠 수 있게 한다.
    if (this.titleInput) window.setTimeout(() => this.titleInput.inputEl.select(), 0);
  }

  autoTitle() {
    return `${isoDate(new Date())} 회의`;
  }

  setTitle(v) {
    this.title = v;
    if (this.titleInput) this.titleInput.setValue(v);
  }

  /** 사용자가 직접 고친 뒤에는 덮어쓰지 않는다. */
  suggestTitle() {
    if (this.titleTouched) return;
    const pre = this.plugin.activeNoteContext();
    const useNote = this.plugin.settings.titleSource === 'activeNote' && pre.title;
    this.setTitle(useNote ? pre.title : this.autoTitle());
  }

  submit() {
    const course = sanitize(this.course === '__new__' ? (this.newCourse || '') : this.course);
    if (!course || course === '무제') { new Notice('프로젝트 이름을 입력하세요.'); return; }
    this.close();
    this.onSubmit({ course, title: sanitize(this.title) });
  }

  onClose() { this.contentEl.empty(); }
}

/** 볼트의 오디오 파일을 골라 다시 처리한다. 파트로 나뉜 회의는 여러 개를 함께 고른다. */
class AudioPickerModal extends Modal {
  constructor(plugin, onPick) {
    super(plugin.app);
    this.plugin = plugin;
    this.onPick = onPick;
    this.selected = new Set();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: '오디오 파일 선택' });
    contentEl.createEl('p', {
      cls: 'meeting-notes-hint',
      text: '한 회의가 여러 파트로 나뉘어 있으면 모두 고르세요. 이름순으로 이어 붙입니다.',
    });

    const exts = ['webm', 'mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'mp4'];
    const files = this.app.vault.getFiles()
      .filter((f) => exts.includes(f.extension.toLowerCase()))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, 200);

    if (!files.length) {
      contentEl.createEl('p', { text: '볼트에서 오디오 파일을 찾지 못했습니다.' });
      return;
    }

    const list = contentEl.createDiv({ cls: 'meeting-notes-picker' });
    files.forEach((f) => {
      const row = list.createEl('label', { cls: 'meeting-notes-picker-item' });
      const box = row.createEl('input', { type: 'checkbox' });
      row.createSpan({ cls: 'meeting-notes-picker-name', text: f.path });
      row.createSpan({ cls: 'meeting-notes-picker-size', text: `${(f.stat.size / 1024 / 1024).toFixed(1)}MB` });
      box.addEventListener('change', () => {
        if (box.checked) this.selected.add(f); else this.selected.delete(f);
        confirm.setDisabled(this.selected.size === 0);
      });
    });

    let confirm;
    new Setting(contentEl).addButton((b) => {
      confirm = b;
      b.setButtonText('선택한 파일로 노트 만들기').setCta().setDisabled(true).onClick(() => {
        const picked = Array.from(this.selected).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
        this.close();
        this.onPick(picked);
      });
    });
  }

  onClose() { this.contentEl.empty(); }
}

/** 모델 목록처럼 긴 텍스트를 보여 주기만 하는 모달. */
class TextModal extends Modal {
  constructor(app, title, body) {
    super(app);
    this.title = title;
    this.body = body;
  }

  onOpen() {
    this.contentEl.createEl('h3', { text: this.title });
    this.contentEl.createEl('pre', { cls: 'meeting-notes-pre', text: this.body });
  }

  onClose() { this.contentEl.empty(); }
}

// ---------------------------------------------------------------- 사이드바

/**
 * 우측 사이드바의 녹음 패널.
 * 노트를 편집하는 동안에도 녹음 상태가 계속 보이고, 정지/일시정지를 여기서 누른다.
 * DOM은 한 번만 만들고 update()로 텍스트와 표시 여부만 바꾼다 (매초 호출되므로).
 */
class MeetingNotesView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return '회의 녹음'; }
  getIcon() { return 'mic'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('meeting-notes-view');

    const head = root.createDiv({ cls: 'mn-head' });
    this.dotEl = head.createSpan({ cls: 'mn-dot' });
    this.stateEl = head.createSpan({ cls: 'mn-state' });

    this.timerEl = root.createDiv({ cls: 'mn-timer' });
    this.metaEl = root.createDiv({ cls: 'mn-meta' });

    // 입력 레벨 미터
    this.meterWrap = root.createDiv({ cls: 'mn-meter-wrap' });
    const bar = this.meterWrap.createDiv({ cls: 'mn-meter' });
    this.meterFill = bar.createDiv({ cls: 'mn-meter-fill' });
    this.meterPeak = bar.createDiv({ cls: 'mn-meter-peak' });
    const scale = this.meterWrap.createDiv({ cls: 'mn-meter-scale' });
    [-60, -40, -20, -12, 0].forEach((db) => {
      scale.createSpan({ cls: 'mn-meter-tick', text: db === 0 ? '0' : String(db) })
        .style.left = `${dbToPercent(db)}%`;
    });
    this.meterText = this.meterWrap.createDiv({ cls: 'mn-meter-text' });
    this.peakHold = METER_FLOOR;

    // 전사·요약 진행률
    this.progressWrap = root.createDiv({ cls: 'mn-progress-wrap' });
    const track = this.progressWrap.createDiv({ cls: 'mn-progress' });
    this.progressFill = track.createDiv({ cls: 'mn-progress-fill' });

    const btns = root.createDiv({ cls: 'mn-buttons' });
    this.startBtn = btns.createEl('button', { cls: 'mod-cta mn-btn', text: '녹음 시작' });
    this.startBtn.addEventListener('click', () => this.plugin.toggleRecording());

    // 회의 언어 — 인식률에 직접 영향을 주므로 녹음 직전에 바꿀 수 있게 버튼 바로 아래에 둔다.
    this.langRow = btns.createDiv({ cls: 'mn-lang' });
    this.langRow.createSpan({ cls: 'mn-lang-label', text: '회의 언어' });
    this.langSelect = this.langRow.createEl('select', { cls: 'dropdown' });
    [['ko', '한국어'], ['en', '영어'], ['mixed', '한·영 복합']].forEach(([value, label]) => {
      const opt = this.langSelect.createEl('option', { text: label });
      opt.value = value;
    });
    this.langSelect.value = this.plugin.settings.spokenLanguage;
    this.langSelect.addEventListener('change', async () => {
      this.plugin.settings.spokenLanguage = this.langSelect.value;
      await this.plugin.saveSettings();
      this.update();
    });
    this.engineHint = btns.createDiv({ cls: 'mn-hint mn-engine-hint' });

    this.pauseBtn = btns.createEl('button', { cls: 'mn-btn', text: '일시정지' });
    this.pauseBtn.addEventListener('click', () => this.plugin.togglePause());

    this.stopBtn = btns.createEl('button', { cls: 'mod-warning mn-btn', text: '정지하고 노트 만들기' });
    this.stopBtn.addEventListener('click', () => this.plugin.toggleRecording());

    this.hintEl = root.createDiv({ cls: 'mn-hint' });
    this.update();
  }

  async onClose() {
    this.stopMeter();
    this.contentEl.empty();
  }

  /** 미터는 초당 1회로는 못 읽는다. 녹음 중에만 rAF로 따로 돈다. */
  startMeter() {
    if (this.raf) return;
    const draw = () => {
      this.raf = window.requestAnimationFrame(draw);
      this.drawMeter();
    };
    this.raf = window.requestAnimationFrame(draw);
  }

  stopMeter() {
    if (this.raf) window.cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  drawMeter() {
    const levels = this.plugin.recorder.getLevels();
    if (!levels) {
      // 일시정지 중이거나 분석기를 못 만든 경우
      this.meterFill.style.width = '0%';
      this.meterFill.removeClass('is-hot', 'is-clip');
      this.meterPeak.style.left = '0%';
      this.meterText.setText(this.plugin.recorder.paused ? '일시정지' : '레벨 측정 불가');
      this.peakHold = METER_FLOOR;
      return;
    }

    this.meterFill.style.width = `${dbToPercent(levels.rmsDb)}%`;
    this.meterFill.toggleClass('is-hot', levels.peakDb > -12 && levels.peakDb <= -1);
    this.meterFill.toggleClass('is-clip', levels.peakDb > -1);

    // 피크는 즉시 올리고 천천히 떨어뜨려야 눈으로 읽힌다.
    this.peakHold = levels.peakDb > this.peakHold
      ? levels.peakDb
      : Math.max(METER_FLOOR, this.peakHold - PEAK_DECAY_DB);
    this.meterPeak.style.left = `${dbToPercent(this.peakHold)}%`;

    this.meterText.setText(`RMS ${formatDb(levels.rmsDb)} · 피크 ${formatDb(this.peakHold)} dBFS`);
  }

  update() {
    if (!this.stateEl) return;
    const plugin = this.plugin;
    const rec = plugin.recorder;
    const recording = Boolean(rec && rec.active);
    const paused = Boolean(rec && rec.paused);

    this.contentEl.toggleClass('is-recording', recording && !paused);

    if (recording) {
      this.stateEl.setText(paused ? '일시정지' : '녹음 중');
      this.timerEl.setText(clock(rec.elapsedMs));
      const session = plugin.session || {};
      const parts = rec.blobs.length + 1;
      this.metaEl.setText(`${session.course || '미분류'} · ${session.title || '무제'}${parts > 1 ? ` · ${parts}부` : ''}`);
      this.hintEl.setText(paused
        ? '일시정지 중입니다. 재개를 누르면 이어서 녹음합니다.'
        : '적정 레벨은 피크 -12 ~ -6 dBFS입니다. 0에 닿으면 소리가 깨집니다.');
    } else if (plugin.busy) {
      const pct = plugin.progressPct || 0;
      this.stateEl.setText('처리 중');
      this.timerEl.setText(`${pct}%`);
      this.metaEl.setText(plugin.progressText || '');
      this.progressFill.style.width = `${pct}%`;
      this.hintEl.setText('끝나면 시작한 노트가 열립니다.');
    } else {
      this.stateEl.setText('대기 중');
      this.timerEl.setText('0:00');
      const pre = plugin.activeNoteContext();
      this.metaEl.setText(pre.title ? `${pre.course || '미분류'} · ${pre.title}` : '열어 둔 노트 없음');
      this.hintEl.setText(pre.title ? '이 이름으로 저장됩니다. 시작할 때 고칠 수 있습니다.' : '노트를 열어 두면 그 제목을 기본값으로 씁니다.');
    }

    this.startBtn.toggle(!recording && !plugin.busy);
    this.langRow.toggle(!recording && !plugin.busy);
    this.engineHint.toggle(!recording && !plugin.busy);
    if (!recording && !plugin.busy) {
      this.langSelect.value = plugin.settings.spokenLanguage;
      const hint = plugin.engineHintText();
      this.engineHint.setText(hint.text);
      this.engineHint.toggleClass('is-warn', hint.warn);
    }
    this.pauseBtn.toggle(recording);
    this.stopBtn.toggle(recording);
    this.pauseBtn.setText(paused ? '재개' : '일시정지');

    this.meterWrap.toggle(recording);
    this.progressWrap.toggle(Boolean(plugin.busy));
    if (recording) this.startMeter();
    else this.stopMeter();
  }
}

// ---------------------------------------------------------------- 플러그인

module.exports = class MeetingNotesPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.keys = new KeyStore(this);
    this.recorder = new Recorder(this);
    this.busy = false;

    this.progressText = '';
    this.progressPct = 0;
    this.registerView(VIEW_TYPE, (leaf) => new MeetingNotesView(leaf, this));

    this.status = this.addStatusBarItem();
    this.status.addClass('meeting-notes-status');
    this.status.addClass('mod-clickable');
    this.status.addEventListener('click', () => this.activateView(true));
    this.renderStatus();
    this.registerInterval(window.setInterval(() => this.renderStatus(), 1000));

    // 열어 둔 노트가 바뀌면 대기 화면의 기본 이름도 따라 바뀐다.
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.renderStatus()));

    this.ribbon = this.addRibbonIcon('mic', '회의 녹음 패널 열기', () => this.activateView(true));
    this.app.workspace.onLayoutReady(() => this.activateView(false));

    this.addCommand({
      id: 'toggle-recording',
      name: '회의 녹음 시작/정지',
      callback: () => this.toggleRecording(),
    });
    this.addCommand({
      id: 'open-view',
      name: '녹음 패널 열기',
      callback: () => this.activateView(true),
    });
    this.addCommand({
      id: 'toggle-pause',
      name: '녹음 일시정지/재개',
      checkCallback: (checking) => {
        if (!this.recorder.active) return false;
        if (!checking) this.togglePause();
        return true;
      },
    });
    this.addCommand({
      id: 'process-existing-audio',
      name: '오디오 파일에서 회의 노트 만들기',
      callback: () => this.processExisting(),
    });
    this.addCommand({
      id: 'resummarize',
      name: '현재 노트 내용으로 다시 요약하기',
      callback: () => this.resummarizeActive(),
    });
    this.addCommand({
      id: 'scaffold-config',
      name: '키 파일 만들기',
      callback: () => this.scaffoldConfig(),
    });
    this.addCommand({
      id: 'check-local-stt',
      name: '로컬 전사 환경 점검',
      callback: () => this.checkLocalStt(),
    });
    this.addCommand({
      id: 'list-models',
      name: '사용 가능한 모델 목록 보기',
      callback: () => this.showModels(),
    });

    this.addSettingTab(new MeetingNotesSettingTab(this.app, this));
  }

  async onunload() {
    // 녹음 중 플러그인이 내려가면 최소한 오디오는 건진다.
    if (this.recorder && this.recorder.active) {
      const session = this.session || { course: '미분류', title: `복구 ${stampOf(new Date())}` };
      try {
        const result = await this.recorder.stop();
        if (result.blobs.length) {
          await this.saveAudio(result, session, session.startedAt || new Date());
          new Notice('플러그인이 내려가서 녹음을 중단하고 오디오만 저장했습니다.');
        }
      } catch (_) { /* 언로드 중이라 더 할 수 있는 게 없다 */ }
    }
  }

  async saveSettings() { await this.saveData(this.settings); }

  /** 우측 사이드바에 녹음 패널을 띄운다. reveal이면 포커스까지 옮긴다. */
  async activateView(reveal) {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return null;
      await leaf.setViewState({ type: VIEW_TYPE, active: Boolean(reveal) });
    }
    if (reveal) workspace.revealLeaf(leaf);
    return leaf;
  }

  views() {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((v) => v instanceof MeetingNotesView);
  }

  togglePause() {
    if (!this.recorder.active) return;
    if (this.recorder.paused) this.recorder.resume();
    else this.recorder.pause();
    this.renderStatus();
  }

  /** 사이드바에 보여 줄 전사 엔진 안내. 화자 구분·복합 언어에서 whisper의 한계를 미리 알려 준다. */
  engineHintText() {
    const s = this.settings;
    const status = this.keys.status();
    const lang = languageProfile(s.spokenLanguage).label;
    if (s.sttEngine === 'whisper') {
      if (s.spokenLanguage === 'mixed') {
        return status.gemini
          ? { warn: false, text: `${lang} · whisper는 한 언어만 잡아서 Gemini API로 전사합니다 (화자 분리 ${s.diarization ? '켜짐' : '꺼짐'}).` }
          : { warn: true, text: `${lang} · whisper는 한 언어만 인식합니다. 영어 발언이 빠질 수 있으니 Gemini 키를 넣어 두세요.` };
      }
      return { warn: true, text: `${lang} · 로컬 whisper. 발언자를 나누지 않습니다. 화자 구분이 중요한 회의면 설정 → 전사 엔진을 Gemini API로 바꾸세요.` };
    }
    if (s.sttEngine === 'gemini') {
      return { warn: false, text: `${lang} · Gemini API · 화자 분리 ${s.diarization ? '켜짐' : '꺼짐'}` };
    }
    return { warn: false, text: `${lang} · OpenAI API (화자 구분 없음)` };
  }

  /** 지금 열어 둔 마크다운 노트에서 프로젝트/제목 기본값을 뽑는다. */
  activeNoteContext() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') return { course: '', title: '', path: '' };
    const parent = file.parent;
    const course = parent && parent.path !== '/' ? parent.name : '';
    return { course, title: file.basename, path: file.path };
  }

  /**
   * 시작한 노트에 이미 있는 사전 메모와, 그 노트가 embed/link한 자료를 모은다.
   * 전사문을 이것과 대조해 용어를 바로잡기 위한 재료다.
   */
  async gatherContext(file) {
    if (!(file instanceof TFile)) return [];
    const pieces = [];

    // 이전에 플러그인이 붙인 정리 블록은 "사전 메모"가 아니다. 빼지 않으면 자기 출력을 다시 먹는다.
    const body = stripGeneratedBlocks(stripFrontmatter(await this.app.vault.read(file)));
    if (body) pieces.push({ label: `사전 메모 — ${file.basename}`, text: body });

    const cache = this.app.metadataCache.getFileCache(file) || {};
    const refs = [...(cache.embeds || []), ...(cache.links || [])];
    const seen = new Set([file.path]);

    for (const ref of refs) {
      const linkPath = String(ref.link || '').split('#')[0].split('|')[0];
      if (!linkPath) continue;
      const linked = this.app.metadataCache.getFirstLinkpathDest(linkPath, file.path);
      if (!linked || seen.has(linked.path)) continue;
      seen.add(linked.path);

      const ext = linked.extension.toLowerCase();
      if (ext === 'md' || ext === 'txt') {
        const text = stripGeneratedBlocks(stripFrontmatter(await this.app.vault.read(linked)));
        if (text) pieces.push({ label: `첨부 노트 — ${linked.name}`, text: clip(text, MAX_CONTEXT_PIECE) });
      } else if (ext === 'pdf') {
        const text = await this.pdfText(linked);
        if (text) pieces.push({ label: `회의 자료 — ${linked.name}`, text: clip(text, MAX_CONTEXT_PIECE) });
      }
    }
    return pieces;
  }

  /** 옵시디언에 실려 있는 pdf.js로 PDF 본문을 뽑는다. 없으면 조용히 건너뛴다. */
  async pdfText(file) {
    const lib = window.pdfjsLib;
    if (!lib || typeof lib.getDocument !== 'function') return '';
    try {
      const data = await this.app.vault.readBinary(file);
      const doc = await lib.getDocument({ data: new Uint8Array(data) }).promise;
      const pages = [];
      const limit = Math.min(doc.numPages, 100);
      for (let i = 1; i <= limit; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const line = content.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
        if (line) pages.push(`[${i}쪽] ${line}`);
      }
      return pages.join('\n');
    } catch (e) {
      console.warn('[meeting-notes] PDF 텍스트 추출 실패', file.path, e);
      return '';
    }
  }

  /** 녹음이 끝난 뒤에 실패할 요인을 시작 전에 모두 찾아낸다. */
  preflight() {
    const problems = [];
    const status = this.keys.status();
    const s = this.settings;
    if (!status.gemini && !status.openai) {
      problems.push('요약에 쓸 API 키가 없습니다. 설정 → API 키에 붙여 넣거나 "키 파일 만들기"를 실행하세요.');
    }
    if (s.sttEngine === 'whisper') {
      problems.push(...new WhisperProvider(this).check());
    } else if (!status[s.sttEngine]) {
      problems.push(`${s.sttEngine === 'gemini' ? 'Gemini' : 'OpenAI'} 키가 없어 API 전사를 할 수 없습니다. 설정에서 전사 엔진을 바꾸거나 키를 채우세요.`);
    }
    return problems;
  }

  /**
   * 전사에 쓸 엔진을 고른다.
   * whisper는 한 파일에서 한 언어만 잡는다 (한·영 복합 실측: 영어 발언 전부 누락).
   * 그래서 복합 언어인데 Gemini 키가 있으면 Gemini로 넘긴다.
   */
  transcriberFor() {
    const s = this.settings;
    const status = this.keys.status();
    let engine = s.sttEngine;

    if (engine === 'whisper' && s.spokenLanguage === 'mixed' && status.gemini) {
      new Notice('한·영 복합 회의는 whisper가 한 언어만 인식해서 Gemini API로 전사합니다.', 8000);
      engine = 'gemini';
    }

    if (engine === 'whisper') {
      return {
        provider: new WhisperProvider(this),
        key: null,
        label: `whisper.cpp · ${nodePath.basename(expandHome(s.whisperModel))}`,
      };
    }
    if (engine === 'gemini') {
      return {
        provider: new GeminiProvider(this),
        key: this.keys.get('gemini'),
        label: `${s.geminiSttModel}${s.diarization ? ' · 화자 분리' : ''}`,
      };
    }
    return { provider: new OpenAIProvider(this), key: this.keys.get('openai'), label: s.openaiSttModel };
  }

  /**
   * 요약 모델. OpenAI luna / terra / sol 중 설정값을 쓰고,
   * 사전 자료가 있으면 대조용 모델과 추론 강도를 적용한다. OpenAI 키가 없으면 Gemini로 대신한다.
   */
  summarizerFor(hasContext) {
    const s = this.settings;
    const status = this.keys.status();

    if (status.openai) {
      const useContext = hasContext && s.useContextModel;
      const model = useContext ? s.contextModel : s.summaryModel;
      return {
        provider: new OpenAIProvider(this),
        key: this.keys.get('openai'),
        opts: useContext ? { model, reasoningEffort: s.contextEffort } : { model },
        label: useContext ? `${model} · reasoning ${s.contextEffort}` : model,
      };
    }
    if (status.gemini) {
      new Notice(`OpenAI 키가 없어 ${s.geminiFallbackModel}로 요약합니다.`, 8000);
      return {
        provider: new GeminiProvider(this),
        key: this.keys.get('gemini'),
        opts: { model: s.geminiFallbackModel },
        label: s.geminiFallbackModel,
      };
    }
    throw new LectureError('요약에 쓸 API 키가 하나도 없습니다. 설정 → API 키를 채우세요.');
  }

  /**
   * 스트리밍으로 요약을 받으며 진행률을 갱신한다.
   * 분모는 전사 길이로 추정한다. 자료 대조 요약은 원문의 40%까지 나오는 걸 실측했다.
   */
  async summarizeWithProgress(summarizer, prompt, sourceLength, notice) {
    const expected = Math.max(800, Math.min(20000, Math.round(sourceLength * 0.3)));
    const [s0, s1] = P_SUMMARIZE;
    this.setProgress(s0, `요약 시작 · ${summarizer.label}`, notice);
    const raw = await summarizer.provider.completeStream(
      summarizer.key,
      prompt,
      (_delta, full) => {
        const frac = Math.min(0.97, full.length / expected);
        this.setProgress(s0 + (s1 - s0) * frac, `요약 생성 중 · ${full.length.toLocaleString()}자`, notice);
      },
      summarizer.opts,
    );
    return stripCodeFence(raw);
  }

  setProgress(pct, text, notice) {
    this.progressPct = Math.max(0, Math.min(100, Math.round(pct)));
    this.progressText = text;
    const label = `${this.progressPct}% · ${text}`;
    if (notice) notice.setMessage(`회의 노트 ${label}`);
    this.views().forEach((v) => v.update());
    this.renderStatusText();
  }

  // ------------------------------------------------------------ 볼트 헬퍼

  listCourses() {
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.noteFolder));
    if (!(folder instanceof TFolder)) return [];
    return folder.children.filter((c) => c instanceof TFolder).map((c) => c.name).sort();
  }

  countNotes(course) {
    if (!course) return 0;
    const p = normalizePath(`${this.settings.noteFolder}/${course}`);
    const folder = this.app.vault.getAbstractFileByPath(p);
    if (!(folder instanceof TFolder)) return 0;
    return folder.children.filter((c) => c instanceof TFile && c.extension === 'md' && !c.name.endsWith(' 전사.md')).length;
  }

  async ensureFolder(path) {
    const p = normalizePath(path);
    if (this.app.vault.getAbstractFileByPath(p)) return;
    const segments = p.split('/');
    let acc = '';
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg;
      if (!this.app.vault.getAbstractFileByPath(acc)) {
        try { await this.app.vault.createFolder(acc); } catch (_) { /* 경합 시 이미 존재 */ }
      }
    }
  }

  /** 같은 이름이 있으면 " (2)", " (3)"을 붙인다. */
  uniquePath(folder, base, ext) {
    let candidate = normalizePath(`${folder}/${base}.${ext}`);
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = normalizePath(`${folder}/${base} (${n}).${ext}`);
      n += 1;
    }
    return candidate;
  }

  // ------------------------------------------------------------ 상태 표시

  /** 진행률만 바뀌었을 때 상태바 텍스트를 빠르게 고친다. */
  renderStatusText() {
    if (this.status && this.busy) this.status.setText(`⏳ ${this.progressPct || 0}%`);
  }

  renderStatus() {
    if (!this.status) return;
    if (this.recorder.active) {
      const icon = this.recorder.paused ? '⏸' : '🔴';
      const parts = this.recorder.blobs.length + 1;
      this.status.setText(`${icon} ${clock(this.recorder.elapsedMs)}${parts > 1 ? ` · ${parts}부` : ''}`);
    } else if (this.busy) {
      this.status.setText(`⏳ ${this.progressPct || 0}%`);
    } else {
      this.status.setText('🎙');
    }
    this.views().forEach((v) => v.update());
  }

  // ------------------------------------------------------------ 명령

  scaffoldConfig() {
    try {
      const p = this.keys.scaffold();
      new Notice(`키 파일을 준비했습니다:\n${p}\n이 파일을 열어 API 키를 채우세요.`, 10000);
      spawn('open', ['-R', p]);
    } catch (e) {
      new Notice(`키 파일 생성 실패: ${e.message}`, 10000);
    }
  }

  /** whisper·ffmpeg·모델이 제대로 있는지 확인해서 보여 준다. */
  async checkLocalStt() {
    const provider = new WhisperProvider(this);
    const problems = provider.check();
    const s = this.settings;
    const lines = [
      `whisper : ${expandHome(s.whisperBinary)}`,
      `ffmpeg  : ${expandHome(s.ffmpegBinary)}`,
      `모델    : ${expandHome(s.whisperModel)}`,
      '',
    ];

    if (problems.length) {
      lines.push('❌ 문제가 있습니다.', '', ...problems);
      new TextModal(this.app, '로컬 전사 환경 점검', lines.join('\n')).open();
      return;
    }

    const model = expandHome(s.whisperModel);
    const sizeMb = (fs.statSync(model).size / 1024 / 1024).toFixed(0);
    lines.push('✅ 준비 완료', '', `모델 크기: ${sizeMb} MB`);
    try {
      const out = await runCommand(expandHome(s.ffmpegBinary), ['-version']);
      lines.push(`ffmpeg: ${out.split('\n')[0]}`);
    } catch (e) {
      lines.push(`ffmpeg 버전 확인 실패: ${e.message}`);
    }
    new TextModal(this.app, '로컬 전사 환경 점검', lines.join('\n')).open();
  }

  async showModels() {
    const status = this.keys.status();
    const notice = new Notice('모델 목록을 불러오는 중…', 0);
    try {
      const out = [];
      if (status.openai) {
        const m = await new OpenAIProvider(this).listModels(this.keys.get('openai'));
        out.push(`## OpenAI (${m.length}개)`, ...m, '');
      }
      if (status.gemini) {
        const m = await new GeminiProvider(this).listModels(this.keys.get('gemini'));
        out.push(`## Gemini (${m.length}개)`, ...m);
      }
      if (!out.length) throw new LectureError('API 키가 없습니다. 설정 → API 키를 채우세요.');
      new TextModal(this.app, '사용 가능한 모델', out.join('\n')).open();
    } catch (e) {
      this.reportError(e);
    } finally {
      notice.hide();
    }
  }

  async toggleRecording() {
    if (this.recorder.active) {
      await this.finishRecording();
      return;
    }
    if (this.busy) { new Notice('이전 회의를 아직 처리 중입니다.'); return; }

    // 다 녹음하고 나서 실패하면 손해가 크다. 끝나고 터질 만한 것은 지금 잡는다.
    const problems = this.preflight();
    if (problems.length) {
      new Notice(`녹음을 시작할 수 없습니다.\n\n${problems.join('\n\n')}`, 20000);
      return;
    }

    // 모달을 열기 전에 대상 노트를 잡아 둔다. 요약을 이어 붙일 때 쓴다.
    const target = this.activeNoteContext();

    new SessionModal(this, async (session) => {
      try {
        await this.recorder.start();
        this.session = Object.assign({ startedAt: new Date(), targetPath: target.path }, session);
        await this.activateView(true);
        this.renderStatus();
        new Notice(`녹음을 시작했습니다: ${session.course} / ${session.title}`);
      } catch (e) {
        this.reportError(e);
      }
    }).open();
  }

  async finishRecording() {
    const session = this.session || { course: '미분류', title: `녹음 ${stampOf(new Date())}` };
    const startedAt = session.startedAt || new Date();
    const result = await this.recorder.stop();
    this.session = null;
    this.renderStatus();

    if (!result.blobs.length) { new Notice('녹음된 오디오가 없습니다.'); return; }

    // 오디오를 먼저 저장한다. 이후 API가 실패해도 원본은 남는다.
    let saved;
    try {
      saved = await this.saveAudio(result, session, startedAt);
    } catch (e) {
      // 볼트에 못 쓰면 다운로드 폴더에라도 남긴다. 90분 녹음을 날리는 것보다 낫다.
      const rescued = await this.rescueAudio(result, session).catch(() => null);
      this.reportError(e, rescued
        ? `오디오는 여기에 임시 저장했습니다:\n${rescued}`
        : '오디오를 어디에도 저장하지 못했습니다.');
      return;
    }
    new Notice(`오디오 ${saved.files.length}개를 저장했습니다.`);

    await this.runPipeline({
      course: session.course,
      title: session.title,
      date: startedAt,
      durationMs: result.durationMs,
      files: saved.files,
      targetPath: session.targetPath,
    });
  }

  /**
   * 오디오를 어느 폴더에 둘지 정한다.
   * 기본은 녹음을 시작할 때 열어 두었던 노트와 같은 폴더다.
   */
  audioFolderFor(session) {
    if (this.settings.audioLocation === 'fixed') return this.settings.audioFolder;

    const targetPath = session && session.targetPath;
    if (targetPath) {
      const idx = targetPath.lastIndexOf('/');
      if (idx > 0) return targetPath.slice(0, idx);
    }
    // 열어 둔 노트가 없으면 이 회의 노트가 만들어질 폴더에 둔다.
    if (session && session.course) return `${this.settings.noteFolder}/${session.course}`;
    return this.settings.audioFolder;
  }

  /** 볼트 저장이 실패했을 때 최후 수단. ~/Downloads 아래에 파트별로 쓴다. */
  async rescueAudio(result, session) {
    const dir = nodePath.join(os.homedir(), 'Downloads', 'meeting-notes-rescue');
    fs.mkdirSync(dir, { recursive: true });
    const base = sanitize(`${stampOf(new Date())} ${session.course || ''} ${session.title || ''}`);
    for (let i = 0; i < result.blobs.length; i++) {
      const suffix = result.blobs.length > 1 ? ` (${i + 1})` : '';
      const buf = Buffer.from(await result.blobs[i].arrayBuffer());
      fs.writeFileSync(nodePath.join(dir, `${base}${suffix}.webm`), buf);
    }
    return dir;
  }

  /** 파트별 Blob을 볼트에 쓴다. 파트가 하나면 접미사를 붙이지 않는다. */
  async saveAudio(result, session, startedAt) {
    const folder = this.audioFolderFor(session);
    await this.ensureFolder(folder);
    const ext = (result.mime || '').includes('mp4') ? 'm4a' : 'webm';
    const base = sanitize(applyTemplate(this.settings.audioNameTemplate, {
      stamp: stampOf(startedAt),
      date: isoDate(startedAt),
      course: session.course,
      title: session.title,
    }));
    const files = [];

    for (let i = 0; i < result.blobs.length; i++) {
      const suffix = result.blobs.length > 1 ? ` (${i + 1})` : '';
      const path = this.uniquePath(folder, `${base}${suffix}`, ext);
      const buf = await result.blobs[i].arrayBuffer();
      files.push(await this.app.vault.createBinary(path, buf));
    }
    return { files };
  }

  async processExisting() {
    if (this.busy) { new Notice('이전 회의를 아직 처리 중입니다.'); return; }
    // 재시도도 첫 녹음과 똑같이 지금 열어 둔 노트에 붙어야 한다.
    const target = this.activeNoteContext();
    new AudioPickerModal(this, (files) => {
      if (!files.length) return;
      new SessionModal(this, (session) => {
        this.runPipeline({
          course: session.course,
          title: session.title,
          date: new Date(files[0].stat.mtime),
          durationMs: 0,
          files,
          targetPath: target.path,
        });
      }, { heading: '회의 노트 만들기', submit: '노트 만들기' }).open();
    }).open();
  }

  /** 자료 수집 → 전사 → 요약 → 노트 반영. 각 단계를 % 로 보고한다. */
  async runPipeline({ course, title, date, durationMs, files, targetPath }) {
    this.busy = true;
    this.renderStatus();
    const notice = new Notice('회의 노트 준비 중…', 0);

    try {
      const stt = this.transcriberFor();
      const noteFolder = `${this.settings.noteFolder}/${course}`;
      const targetFile = targetPath ? this.app.vault.getAbstractFileByPath(targetPath) : null;

      // 1) 시작한 노트의 사전 메모와 거기 붙은 자료를 모은다.
      this.setProgress(P_CONTEXT[0], '자료 확인 중…', notice);
      const context = targetFile instanceof TFile ? await this.gatherContext(targetFile) : [];
      const hasContext = context.length > 0;
      this.setProgress(P_CONTEXT[1], hasContext ? `자료 ${context.length}건 확보` : '자료 없음', notice);

      // 자료에서 뽑은 용어를 whisper 초기 프롬프트로 넣으면 오인식이 줄어든다.
      const termPrompt = (this.settings.sttEngine === 'whisper' && this.settings.whisperTermPrompt)
        ? buildTermPrompt(context, course)
        : '';

      // 2) 전사
      const [t0, t1] = P_TRANSCRIBE;
      const span = (t1 - t0) / files.length;
      const segments = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const bytes = new Uint8Array(await this.app.vault.readBinary(file));
        const part = { bytes, filename: file.name, mime: mimeFor(file.extension) };
        const label = files.length > 1 ? ` ${i + 1}/${files.length}` : '';
        const base = t0 + span * i;
        const text = await stt.provider.transcribe(stt.key, part, (msg, frac) => {
          this.setProgress(base + span * (frac || 0), `전사${label} · ${msg}`, notice);
        }, { termPrompt });
        segments.push(files.length > 1 ? `## ${i + 1}부\n\n${text}` : text);
      }
      const transcript = segments.join('\n\n');
      this.setProgress(t1, `전사 완료 · ${transcript.length.toLocaleString()}자`, notice);

      // 3) 전사 원문은 별도 노트로 남긴다.
      let transcriptFile = null;
      if (this.settings.saveTranscript) {
        await this.ensureFolder(noteFolder);
        const path = this.uniquePath(noteFolder, `${title} 전사`, 'md');
        transcriptFile = await this.app.vault.create(
          path,
          this.buildTranscriptNote({ course, title, date, files, transcript, stt }),
        );
      }

      // 4) 요약. 스트리밍이라 받은 글자 수로 실제 진행률을 만든다.
      const summarizer = this.summarizerFor(hasContext);
      const prompt = this.fillPrompt(
        hasContext ? this.settings.contextPrompt : this.settings.summaryPrompt,
        { course, title, date, durationMs, transcript, context },
      );
      const summary = await this.summarizeWithProgress(summarizer, prompt, transcript.length, notice);

      // 5) 시작한 노트에 이어 붙이거나, 없으면 새 노트를 만든다.
      this.setProgress(P_SUMMARIZE[1], '노트 정리 중…', notice);
      let note;
      if (this.settings.summaryTarget === 'append' && targetFile instanceof TFile) {
        await this.app.vault.append(
          targetFile,
          this.buildAppendBlock({ date, files, transcriptFile, summary, summarizer, hasContext, stt }),
        );
        note = targetFile;
      } else {
        await this.ensureFolder(noteFolder);
        const notePath = this.uniquePath(noteFolder, title, 'md');
        note = await this.app.vault.create(
          notePath,
          this.buildMeetingNote({ course, title, date, durationMs, files, transcriptFile, summary, summarizer, stt, hasContext }),
        );
      }

      this.setProgress(100, '완료', notice);
      notice.hide();
      new Notice(`회의 노트 정리 완료: ${note.path}`);
      await this.revealNote(note);
    } catch (e) {
      notice.hide();
      this.reportError(e, '오디오는 볼트에 저장돼 있습니다. "오디오 파일에서 회의 노트 만들기"로 다시 시도할 수 있습니다.');
    } finally {
      this.busy = false;
      this.progressPct = 0;
      this.renderStatus();
    }
  }

  /** 이미 열려 있는 노트면 새 탭을 만들지 않고 그 탭으로 이동한다. */
  async revealNote(note) {
    const open = this.app.workspace.getLeavesOfType('markdown')
      .find((leaf) => leaf.view && leaf.view.file && leaf.view.file.path === note.path);
    if (open) {
      this.app.workspace.revealLeaf(open);
      this.app.workspace.setActiveLeaf(open, { focus: true });
      return;
    }
    await this.app.workspace.getLeaf(true).openFile(note);
  }

  /** 프롬프트 자리표시자를 채운다. */
  fillPrompt(template, { course, title, date, durationMs, transcript, context }) {
    const contextText = (context || [])
      .map((c) => `### ${c.label}\n${c.text}`)
      .join('\n\n');
    // 전사문·PDF에 "$&" 같은 문자가 있어도 그대로 들어가야 한다.
    return String(template)
      .replace(/\{\{course\}\}/g, literal(course))
      .replace(/\{\{title\}\}/g, literal(title))
      .replace(/\{\{date\}\}/g, literal(isoDate(date)))
      .replace(/\{\{duration\}\}/g, literal(durationMs ? humanDuration(durationMs) : '길이 미상'))
      .replace(/\{\{context\}\}/g, literal(contextText))
      .replace(/\{\{transcript\}\}/g, literal(transcript));
  }

  /**
   * 준비한 회의 노트 맨 아래에 붙일 블록.
   * 녹음·전사 링크는 본문을 밀어내지 않도록 맨 끝에 둔다.
   */
  buildAppendBlock({ date, files, transcriptFile, summary, summarizer, hasContext, stt }) {
    const lines = ['', '', '---', '', `${GENERATED_HEADING} — ${isoDate(date)}`, '', summary, ''];
    lines.push('', '---', '', '### 녹음 원본', '');
    files.forEach((f) => lines.push(`![[${f.path}]]`));
    if (transcriptFile) lines.push('', `전사 원문: [[${transcriptFile.path}|${transcriptFile.basename}]]`);
    const how = hasContext ? '자료 대조 요약' : '전사 요약';
    lines.push('', `<sub>${how} · 전사 ${stt ? stt.label : '?'} · 요약 ${summarizer.label}</sub>`, '');
    return lines.join('\n');
  }

  buildTranscriptNote({ course, title, date, files, transcript, stt }) {
    const fm = [
      '---',
      `course: ${course}`,
      `meeting: ${title}`,
      `date: ${isoDate(date)}`,
      'type: transcript',
      `stt: ${stt ? stt.label : '?'}`,
      '---',
      '',
    ].join('\n');
    const links = files.map((f) => `![[${f.path}]]`).join('\n');
    return `${fm}${links}\n\n---\n\n${transcript}\n`;
  }

  buildMeetingNote({ course, title, date, durationMs, files, transcriptFile, summary, summarizer, stt, hasContext }) {
    const fm = [
      '---',
      `course: ${course}`,
      `meeting: ${title}`,
      `date: ${isoDate(date)}`,
      'type: meeting-note',
      durationMs ? `duration: ${humanDuration(durationMs)}` : null,
      `stt: ${stt ? stt.label : '?'}`,
      summarizer ? `summary_model: ${summarizer.label}` : null,
      '---',
      '',
    ].filter(Boolean).join('\n');

    // 이어 붙이기와 같은 제목을 써서, 이 노트를 열고 다시 녹음해도 자기 출력이 자료로 섞이지 않게 한다.
    const body = [`${GENERATED_HEADING} — ${isoDate(date)}`, '', summary];

    const tail = ['', '', '---', '', '### 녹음 원본', ''];
    files.forEach((f) => tail.push(`![[${f.path}]]`));
    if (transcriptFile) tail.push('', `전사 원문: [[${transcriptFile.path}|${transcriptFile.basename}]]`);
    const how = hasContext ? '자료 대조 요약' : '전사 요약';
    tail.push('', `<sub>${how} · 전사 ${stt ? stt.label : '?'} · 요약 ${summarizer ? summarizer.label : '?'}</sub>`);

    return `${fm}${body.join('\n')}\n${tail.join('\n')}\n`;
  }

  /**
   * 열어 둔 노트의 본문(플러그인이 붙인 정리 블록은 제외)을 전사문으로 보고 다시 요약한다.
   * 프롬프트를 고친 뒤 결과를 다시 뽑아 볼 때 쓴다. 결과는 별도 파일로 둔다.
   */
  async resummarizeActive() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') { new Notice('마크다운 노트를 연 상태에서 실행하세요.'); return; }
    if (this.busy) { new Notice('이전 작업이 아직 처리 중입니다.'); return; }

    this.busy = true;
    this.renderStatus();
    const notice = new Notice('다시 요약 준비 중…', 0);
    try {
      const source = stripGeneratedBlocks(stripFrontmatter(await this.app.vault.read(file)));
      if (!source) {
        throw new LectureError('요약할 본문이 없습니다. 플러그인이 만든 정리 블록은 재요약 대상에서 빠집니다.');
      }

      const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {};
      const course = fm.course || (file.parent && file.parent.name) || '미분류';
      const title = fm.meeting || file.basename;
      const parsed = fm.date ? new Date(fm.date) : null;
      const date = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(file.stat.mtime);

      const summarizer = this.summarizerFor(false);
      const prompt = this.fillPrompt(this.settings.summaryPrompt, {
        course, title, date, durationMs: 0, transcript: source, context: [],
      });
      const summary = await this.summarizeWithProgress(summarizer, prompt, source.length, notice);

      const folder = file.parent ? file.parent.path : this.settings.noteFolder;
      const note = await this.app.vault.create(
        this.uniquePath(folder, `${title} 재요약`, 'md'),
        `${GENERATED_HEADING} — ${isoDate(new Date())}\n\n${summary}\n\n<sub>재요약 · ${summarizer.label}</sub>\n`,
      );

      notice.hide();
      new Notice(`요약본을 만들었습니다: ${note.path}`);
      await this.revealNote(note);
    } catch (e) {
      notice.hide();
      this.reportError(e);
    } finally {
      this.busy = false;
      this.progressPct = 0;
      this.renderStatus();
    }
  }

  reportError(e, hint) {
    const msg = e instanceof LectureError ? e.message : redact(e && e.message ? e.message : String(e));
    console.error('[meeting-notes]', e);
    new Notice(`회의 노트 오류\n${msg}${hint ? `\n\n${hint}` : ''}`, 20000);
  }
};

/**
 * Node의 https로 직접 POST하고 SSE 조각을 흘려보낸다.
 * requestUrl은 응답을 다 받은 뒤에야 돌려줘서 요약 진행률을 만들 수 없다.
 */
function streamPost({ url, headers, body, parseLine, onDelta }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (_) {
      reject(new LectureError(`잘못된 요청 주소입니다: ${url}`));
      return;
    }

    const payload = Buffer.from(body, 'utf8');
    const req = https.request({
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: Object.assign({}, headers, { 'Content-Length': payload.length }),
    }, (res) => {
      res.setEncoding('utf8');
      let pending = '';
      let full = '';
      let errorBody = '';
      const failed = res.statusCode >= 300;

      res.on('data', (chunk) => {
        if (failed) { errorBody += chunk; return; }
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) {
          const piece = parseLine(line.trim());
          if (piece) { full += piece; onDelta(piece, full); }
        }
      });

      res.on('end', () => {
        if (failed) {
          reject(new LectureError(`요약 요청 실패 (HTTP ${res.statusCode})\n${redact(errorBody.slice(0, 400))}`));
          return;
        }
        const tail = parseLine(pending.trim());
        if (tail) full += tail;
        resolve(full.trim());
      });
    });

    req.on('error', (e) => reject(new LectureError(`네트워크 오류: ${e.message}`)));
    req.setTimeout(900000, () => req.destroy(new Error('응답 시간이 너무 깁니다')));
    req.write(payload);
    req.end();
  });
}

/** OpenAI SSE 한 줄에서 델타 텍스트를 뽑는다. */
function parseOpenAiSse(line) {
  if (!line.startsWith('data:')) return '';
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return '';
  try {
    return JSON.parse(payload).choices?.[0]?.delta?.content || '';
  } catch (_) { return ''; }
}

/** Gemini SSE 한 줄에서 델타 텍스트를 뽑는다. */
function parseGeminiSse(line) {
  if (!line.startsWith('data:')) return '';
  const payload = line.slice(5).trim();
  if (!payload) return '';
  try {
    const parts = JSON.parse(payload).candidates?.[0]?.content?.parts || [];
    return parts.map((x) => x.text).filter(Boolean).join('');
  } catch (_) { return ''; }
}

/** 진폭(0~1)을 dBFS로 바꾼다. 완전 무음은 -Infinity 대신 하한값으로 눌러 준다. */
function toDbfs(amplitude) {
  if (!(amplitude > 0)) return METER_FLOOR;
  return Math.max(METER_FLOOR, 20 * Math.log10(amplitude));
}

/** dBFS를 미터 폭(0~100%)으로 바꾼다. */
function dbToPercent(db) {
  const pct = ((db - METER_FLOOR) / -METER_FLOOR) * 100;
  return Math.max(0, Math.min(100, pct));
}

function formatDb(db) {
  if (db <= METER_FLOOR) return '-∞';
  return `${db >= 0 ? '' : ''}${db.toFixed(1)}`;
}

/** 파일명 템플릿의 자리표시자를 채운다. */
function applyTemplate(tpl, vars) {
  return String(tpl)
    .replace(/\{\{stamp\}\}/g, literal(vars.stamp))
    .replace(/\{\{course\}\}/g, literal(vars.course))
    .replace(/\{\{title\}\}/g, literal(vars.title))
    .replace(/\{\{date\}\}/g, literal(vars.date))
    .replace(/\s+/g, ' ')
    .trim();
}

function mimeFor(ext) {
  const map = {
    webm: 'audio/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    mp4: 'audio/mp4',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    aac: 'audio/aac',
  };
  return map[String(ext).toLowerCase()] || 'application/octet-stream';
}

/** 외부 명령을 돌리고 stdout을 돌려준다. stderr는 진행률 파싱용으로 흘려보낸다. */
function runCommand(bin, args, onStderr) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args);
    } catch (e) {
      reject(new LectureError(`${bin} 실행 실패: ${e.message}`));
      return;
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => {
      const chunk = d.toString();
      err += chunk;
      if (onStderr) onStderr(chunk);
    });
    child.on('error', (e) => reject(new LectureError(
      `${bin} 을(를) 실행할 수 없습니다: ${e.message}\n설정에서 경로를 확인하세요.`,
    )));
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new LectureError(`${nodePath.basename(bin)} 종료 코드 ${code}\n${err.slice(-500)}`));
    });
  });
}

// 초기 프롬프트에서 걸러 낼 흔한 말들.
const TERM_STOPWORDS = new Set([
  '그리고', '하지만', '그래서', '그런데', 'however', '되어야', '있습니다', '합니다', '입니다',
  '때문에', '경우에', '대해서', '위해서', '통해서', '이것은', '그것은', '우리가', '여기서',
  '다음과', '같이', '내용을', '부분을', '회의', '미팅', '오늘', '지난주', '다음주', '아젠다', '안건', '참석자',
  'meeting', 'agenda', 'action', 'item', 'update', 'sync',
]);

/**
 * 사전 메모와 회의 자료에서 전문용어를 뽑아 whisper 초기 프롬프트를 만든다.
 * whisper는 프롬프트에 나온 표기를 우선 채택해서 "크론 바로 알파" 같은 오인식을 줄여 준다.
 * 프롬프트 상한이 224토큰이라 글자 수로 잘라 낸다.
 */
function buildTermPrompt(context, course, maxChars = 320) {
  const text = (context || []).map((c) => c.text).join(' ');
  if (!text) return '';

  const tokens = text.match(/[A-Za-z][A-Za-z0-9'\u2019-]{1,}|[가-힣]{2,}/g) || [];
  const counts = new Map();
  for (const raw of tokens) {
    const t = raw.trim();
    if (t.length < 2 || TERM_STOPWORDS.has(t)) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }

  // 자주 나오고 긴 낱말일수록 그 회의의 핵심 용어일 가능성이 높다.
  const ranked = [...counts.entries()]
    .filter(([w, n]) => n >= 2 || /[A-Za-z]/.test(w) || w.length >= 4)
    .sort((a, b) => (b[1] * b[0].length) - (a[1] * a[0].length))
    .map(([w]) => w);

  const picked = [];
  let budget = maxChars - course.length - 8;
  for (const w of ranked) {
    if (budget - (w.length + 2) < 0) break;
    picked.push(w);
    budget -= w.length + 2;
  }
  return picked.length ? `${course} 회의. ${picked.join(', ')}.` : '';
}

/**
 * Gemini 화자 주석(word_info)을 "화자 1: …" 문단으로 바꾼다.
 * start_index/end_index는 바이트 오프셋이라 한글에서 어긋나므로 쓰지 않고, 주석 안의 text를 이어 붙인다.
 * 주석이 없으면 본문을 그대로 돌려준다.
 */
function renderSpeakers(text, annotations) {
  const words = (annotations || []).filter((a) => a && a.speaker && a.text != null);
  if (!words.length) return text;
  const ids = new Map();
  const nameOf = (spk) => {
    if (!ids.has(spk)) ids.set(spk, ids.size + 1);
    return `화자 ${ids.get(spk)}`;
  };
  const lines = [];
  let current = null;
  let buf = [];
  for (const w of words) {
    if (current !== null && w.speaker !== current) {
      lines.push(`${nameOf(current)}: ${buf.join(' ')}`);
      buf = [];
    }
    current = w.speaker;
    buf.push(String(w.text).trim());
  }
  if (buf.length) lines.push(`${nameOf(current)}: ${buf.join(' ')}`);
  return lines.join('\n');
}

/** 노트 앞머리의 YAML 프론트매터를 떼어 낸다. */
function stripFrontmatter(raw) {
  return String(raw).replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

const GENERATED_HEADING = '## 📝 회의 정리';

/**
 * 플러그인이 붙인 "🎙 회의 정리" 블록을 모두 걷어 낸다.
 * 이걸 안 하면 두 번째 녹음부터 이전 요약이 "학생 사전 메모"로 취급돼 자기 출력을 다시 먹는다.
 * 블록은 구분선(---) + 제목으로 시작해 <sub>…</sub> 로 끝난다. 그 뒤에 학생이 직접 쓴 글은 남긴다.
 */
function stripGeneratedBlocks(body) {
  const re = new RegExp(
    '(?:\\n-{3,}\\n+)?' + GENERATED_HEADING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + '[\\s\\S]*?(?:<\\/sub>[ \\t]*\\n?|(?=\\n-{3,}\\n+' + GENERATED_HEADING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')|$)',
    'g',
  );
  return String(body).replace(re, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 긴 텍스트를 잘라 내고 잘렸다는 표시를 남긴다. */
function clip(text, max) {
  const t = String(text);
  return t.length <= max ? t : `${t.slice(0, max)}\n\n[… 이하 ${(t.length - max).toLocaleString()}자 생략]`;
}

/** String.replace의 치환 문자열은 $&, $1 을 해석한다. 사용자 텍스트를 넣을 때는 함수로 감싼다. */
function literal(value) {
  return () => String(value == null ? '' : value);
}

/** 모델이 답변 전체를 ```markdown 으로 감싸는 경우를 벗겨 낸다. */
function stripCodeFence(text) {
  const m = String(text).trim().match(/^```(?:markdown|md)?\n([\s\S]*)\n```$/);
  return m ? m[1].trim() : String(text).trim();
}

// ---------------------------------------------------------------- 설정 화면

class MeetingNotesSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const cfg = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    const status = this.plugin.keys.status();

    // ---- 전사
    containerEl.createEl('h3', { text: '전사' });

    new Setting(containerEl)
      .setName('전사 엔진')
      .setDesc('whisper는 무료이고 오디오가 맥 밖으로 나가지 않지만 발언자를 나누지 않습니다. 여러 명이 번갈아 말하는 회의라면 Gemini API를 권장합니다.')
      .addDropdown((d) => d
        .addOption('whisper', '로컬 whisper.cpp (무료 · 화자 구분 없음)')
        .addOption('gemini', 'Gemini API (화자 구분 지원)')
        .addOption('openai', 'OpenAI API')
        .setValue(cfg.sttEngine)
        .onChange(async (v) => { cfg.sttEngine = v; await save(); this.display(); }));

    if (cfg.sttEngine === 'whisper') {
      containerEl.createEl('p', {
        cls: 'meeting-notes-hint meeting-notes-warn',
        text: '⚠ 화자 구분이 중요하거나 한·영이 섞이는 회의라면 Gemini API를 쓰세요. whisper는 발언자를 나누지 않고, '
          + '복합 언어에서는 한 언어만 인식합니다(실측: 영어 발언 전부 누락). '
          + '회의 언어를 "한·영 복합"으로 두면 Gemini 키가 있을 때 자동으로 Gemini로 전사합니다.',
      });
      new Setting(containerEl)
        .setName('환경 점검')
        .setDesc('whisper·ffmpeg·모델 파일이 준비됐는지 확인합니다.')
        .addButton((btn) => btn.setButtonText('점검').onClick(() => this.plugin.checkLocalStt()));
      this.pathSetting(containerEl, 'whisper 실행 파일', 'whisperBinary');
      this.pathSetting(containerEl, 'whisper 모델', 'whisperModel');
      this.pathSetting(containerEl, 'ffmpeg 실행 파일', 'ffmpegBinary');
      new Setting(containerEl)
        .setName('용어 프롬프트 주입')
        .setDesc('노트와 첨부 문서에서 뽑은 이름·용어를 whisper에 미리 알려 줍니다. 오인식이 줄어듭니다.')
        .addToggle((t) => t.setValue(cfg.whisperTermPrompt).onChange(async (v) => { cfg.whisperTermPrompt = v; await save(); }));
      new Setting(containerEl)
        .setName('스레드 수')
        .setDesc('0이면 whisper 기본값을 씁니다.')
        .addText((t) => t.setValue(String(cfg.whisperThreads)).onChange(async (v) => {
          const n = parseInt(v, 10);
          cfg.whisperThreads = Number.isFinite(n) && n > 0 ? n : 0;
          await save();
        }));
    }

    if (cfg.sttEngine === 'gemini') {
      new Setting(containerEl)
        .setName('화자 분리')
        .setDesc('켜면 "화자 1: …" 형태로 발언자를 구분합니다. Gemini 한도 때문에 파트 길이가 30분을 넘으면 안 됩니다 (기본 25분).')
        .addToggle((t) => t.setValue(cfg.diarization).onChange(async (v) => { cfg.diarization = v; await save(); this.plugin.renderStatus(); }));
      this.modelSetting(containerEl, 'Gemini 전사 모델', 'geminiSttModel', DEFAULT_SETTINGS.geminiSttModel);
    }

    if (cfg.sttEngine === 'openai') {
      this.modelSetting(containerEl, 'OpenAI 전사 모델', 'openaiSttModel', DEFAULT_SETTINGS.openaiSttModel);
      containerEl.createEl('p', { cls: 'meeting-notes-hint', text: 'OpenAI 전사는 파일당 25MB 한도가 있고 화자를 구분하지 않습니다.' });
    }

    new Setting(containerEl)
      .setName('회의 언어')
      .setDesc('패널의 녹음 시작 버튼 아래에서도 바꿀 수 있습니다. 한·영 복합은 Gemini API에서 가장 정확합니다.')
      .addDropdown((d) => d
        .addOption('ko', '한국어')
        .addOption('en', '영어')
        .addOption('mixed', '한·영 복합')
        .setValue(cfg.spokenLanguage)
        .onChange(async (v) => { cfg.spokenLanguage = v; await save(); this.plugin.renderStatus(); }));

    new Setting(containerEl)
      .setName('전사 원문 노트 저장')
      .setDesc('끄면 전사 파일을 만들지 않습니다. 켜면 요약이 마음에 안 들 때 재전사 없이 다시 요약할 수 있습니다.')
      .addToggle((t) => t.setValue(cfg.saveTranscript).onChange(async (v) => { cfg.saveTranscript = v; await save(); }));

    // ---- 요약
    containerEl.createEl('h3', { text: '요약' });

    const modelDropdown = (d, key) => {
      SUMMARY_MODELS.forEach((m) => d.addOption(m, m));
      if (!SUMMARY_MODELS.includes(cfg[key])) d.addOption(cfg[key], `${cfg[key]} (직접 설정)`);
      d.setValue(cfg[key]).onChange(async (v) => { cfg[key] = v; await save(); });
    };

    new Setting(containerEl)
      .setName('요약 모델')
      .setDesc('OpenAI GPT-5.6 계열 중 선택합니다. 사용 가능 여부는 아래 "모델 목록"으로 확인하세요.')
      .addDropdown((d) => modelDropdown(d, 'summaryModel'));

    new Setting(containerEl)
      .setName('사전 자료가 있을 때 대조 모델 사용')
      .setDesc('노트에 아젠다·메모·첨부 문서가 있으면 그것과 전사문을 대조·검증·보완합니다. 끄면 위 요약 모델을 그대로 씁니다.')
      .addToggle((t) => t.setValue(cfg.useContextModel).onChange(async (v) => { cfg.useContextModel = v; await save(); this.display(); }));

    if (cfg.useContextModel) {
      new Setting(containerEl).setName('대조 모델').addDropdown((d) => modelDropdown(d, 'contextModel'));
      new Setting(containerEl)
        .setName('추론 강도')
        .setDesc('대조·검증은 추론이 많이 필요해 high를 권장합니다.')
        .addDropdown((d) => d
          .addOption('low', 'low').addOption('medium', 'medium').addOption('high', 'high')
          .setValue(cfg.contextEffort).onChange(async (v) => { cfg.contextEffort = v; await save(); }));
    }

    this.modelSetting(containerEl, 'OpenAI 키가 없을 때 대체 모델 (Gemini)', 'geminiFallbackModel', DEFAULT_SETTINGS.geminiFallbackModel);

    new Setting(containerEl)
      .setName('모델 목록')
      .setDesc('키가 있는 제공자의 실제 사용 가능 모델을 조회합니다.')
      .addButton((btn) => btn.setButtonText('불러오기').onClick(() => this.plugin.showModels()));

    // ---- API 키
    containerEl.createEl('h3', { text: 'API 키' });
    containerEl.createEl('p', {
      cls: 'meeting-notes-hint',
      text: '아래 칸에 붙여 넣는 게 가장 간단합니다. 단, 이 값은 볼트 안 .obsidian/plugins/meeting-notes/data.json 에 저장되므로 '
        + '볼트를 Git·iCloud·Obsidian Sync로 동기화하면 키도 함께 올라갑니다. 동기화하는 볼트라면 아래 "키 파일"을 쓰세요.',
    });
    this.keySetting(containerEl, 'OpenAI API 키', 'openai',
      'platform.openai.com/api-keys 에서 발급. 요약(luna/terra/sol)과 자료 대조에 쓰입니다.');
    this.keySetting(containerEl, 'Gemini API 키', 'gemini',
      'aistudio.google.com/apikey 에서 발급. 화자 분리·복합 언어 전사, OpenAI 키가 없을 때 요약 대체.');

    new Setting(containerEl)
      .setName(`${status.exists ? '✅' : '❌'} 키 파일 (권장)`)
      .setDesc(`볼트 밖 JSON 파일. 위 칸이 비어 있을 때 여기서 읽습니다. ${status.exists ? '파일 있음' : '파일이 없습니다 — 오른쪽 버튼으로 만드세요'}`)
      .addText((t) => t
        .setPlaceholder(DEFAULT_SETTINGS.configPath)
        .setValue(cfg.configPath)
        .onChange(async (v) => { cfg.configPath = v.trim() || DEFAULT_SETTINGS.configPath; await save(); }))
      .addButton((btn) => btn
        .setButtonText('만들기 / 열기')
        .onClick(() => { this.plugin.scaffoldConfig(); setTimeout(() => this.display(), 500); }));

    // ---- 녹음
    containerEl.createEl('h3', { text: '녹음' });

    new Setting(containerEl)
      .setName('입력 장치')
      .setDesc('비워 두면 macOS 기본 입력 장치를 씁니다. 회의실이면 외장 마이크를 고르세요.')
      .addDropdown(async (d) => {
        d.addOption('', '시스템 기본');
        d.setValue(cfg.inputDeviceId);
        d.onChange(async (v) => { cfg.inputDeviceId = v; await save(); });
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          devices
            .filter((dev) => dev.kind === 'audioinput' && dev.deviceId)
            .forEach((dev) => d.addOption(dev.deviceId, dev.label || `입력 장치 ${dev.deviceId.slice(0, 6)}`));
          d.setValue(cfg.inputDeviceId);
        } catch (_) { /* 장치 열거 실패는 무시 */ }
      });

    new Setting(containerEl)
      .setName('파트 길이 (분)')
      .setDesc('이 길이마다 녹음 파일을 끊습니다. Gemini 화자 분리·복합 언어는 파트당 30분, OpenAI는 25MB가 한도입니다.')
      .addText((t) => t.setValue(String(cfg.chunkMinutes)).onChange(async (v) => {
        const n = parseInt(v, 10);
        cfg.chunkMinutes = Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.chunkMinutes;
        await save();
      }));

    new Setting(containerEl)
      .setName('오디오 비트레이트 (bps)')
      .setDesc('32000이면 말소리 전사에 충분하고 1시간에 약 14MB입니다.')
      .addText((t) => t.setValue(String(cfg.audioBitrate)).onChange(async (v) => {
        const n = parseInt(v, 10);
        cfg.audioBitrate = Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.audioBitrate;
        await save();
      }));

    new Setting(containerEl)
      .setName('녹음 중 절전 방지')
      .setDesc('caffeinate로 맥북이 잠들어 녹음이 끊기는 것을 막습니다.')
      .addToggle((t) => t.setValue(cfg.keepAwake).onChange(async (v) => { cfg.keepAwake = v; await save(); }));

    // ---- 저장 위치
    containerEl.createEl('h3', { text: '저장 위치' });

    new Setting(containerEl)
      .setName('오디오 저장 위치')
      .setDesc('기본은 녹음 시작 시 열어 두었던 노트와 같은 폴더입니다.')
      .addDropdown((d) => d
        .addOption('noteFolder', '노트와 같은 폴더')
        .addOption('fixed', '아래 지정한 폴더')
        .setValue(cfg.audioLocation)
        .onChange(async (v) => { cfg.audioLocation = v; await save(); this.display(); }));

    new Setting(containerEl)
      .setName('오디오 폴더')
      .setDesc(cfg.audioLocation === 'fixed' ? '모든 녹음이 이 폴더에 저장됩니다.' : '열어 둔 노트도 프로젝트도 없을 때만 쓰는 최후 폴더입니다.')
      .addText((t) => t.setValue(cfg.audioFolder).onChange(async (v) => { cfg.audioFolder = v.trim() || DEFAULT_SETTINGS.audioFolder; await save(); }));

    new Setting(containerEl)
      .setName('노트 폴더')
      .setDesc('열어 둔 노트 없이 녹음하면 이 폴더 아래 프로젝트별 하위 폴더에 새 노트를 만듭니다.')
      .addText((t) => t.setValue(cfg.noteFolder).onChange(async (v) => { cfg.noteFolder = v.trim() || DEFAULT_SETTINGS.noteFolder; await save(); }));

    // ---- 이름 짓기
    containerEl.createEl('h3', { text: '이름 짓기' });

    new Setting(containerEl)
      .setName('제목 기본값')
      .setDesc('녹음 시작 모달에 미리 채워 넣을 회의 제목입니다. 시작할 때 언제든 고칠 수 있습니다.')
      .addDropdown((d) => d
        .addOption('activeNote', '열어 둔 노트의 제목')
        .addOption('auto', '자동 (오늘 날짜 회의)')
        .setValue(cfg.titleSource)
        .onChange(async (v) => { cfg.titleSource = v; await save(); }));

    new Setting(containerEl)
      .setName('오디오 파일명')
      .setDesc('쓸 수 있는 자리표시자: {{stamp}} {{date}} {{course}} {{title}} — course는 프로젝트(상위 폴더)입니다.')
      .addText((t) => t
        .setPlaceholder(DEFAULT_SETTINGS.audioNameTemplate)
        .setValue(cfg.audioNameTemplate)
        .onChange(async (v) => {
          cfg.audioNameTemplate = v.trim() || DEFAULT_SETTINGS.audioNameTemplate;
          await save();
          preview.setDesc(this.previewText());
        }));

    const preview = new Setting(containerEl).setName('미리보기').setDesc(this.previewText());
    preview.settingEl.addClass('meeting-notes-preview');

    new Setting(containerEl)
      .setName('정리를 저장할 곳')
      .setDesc('"열어 둔 노트에 이어 붙이기"를 고르면 준비한 회의 노트 맨 아래에 덧붙입니다. 기존 내용은 지우지 않습니다.')
      .addDropdown((d) => d
        .addOption('newNote', '새 노트로 만들기')
        .addOption('append', '열어 둔 노트에 이어 붙이기')
        .setValue(cfg.summaryTarget)
        .onChange(async (v) => { cfg.summaryTarget = v; await save(); }));

    // ---- 프롬프트
    containerEl.createEl('h3', { text: '프롬프트' });

    new Setting(containerEl)
      .setName('요약 프롬프트')
      .setDesc('{{transcript}} {{course}} {{title}} {{date}} {{duration}} 을 쓸 수 있습니다.')
      .addExtraButton((btn) => btn.setIcon('rotate-ccw').setTooltip('기본값으로 되돌리기').onClick(async () => {
        cfg.summaryPrompt = DEFAULT_PROMPT; await save(); this.display();
      }));
    const ta = containerEl.createEl('textarea', { cls: 'meeting-notes-prompt' });
    ta.value = cfg.summaryPrompt;
    ta.rows = 16;
    ta.addEventListener('change', async () => { cfg.summaryPrompt = ta.value; await save(); });

    if (cfg.useContextModel) {
      new Setting(containerEl)
        .setName('대조 프롬프트')
        .setDesc('{{context}} 에 사전 메모·자료가, {{transcript}} 에 전사문이 들어갑니다.')
        .addExtraButton((btn) => btn.setIcon('rotate-ccw').setTooltip('기본값으로 되돌리기').onClick(async () => {
          cfg.contextPrompt = DEFAULT_CONTEXT_PROMPT; await save(); this.display();
        }));
      const ctx = containerEl.createEl('textarea', { cls: 'meeting-notes-prompt' });
      ctx.value = cfg.contextPrompt;
      ctx.rows = 16;
      ctx.addEventListener('change', async () => { cfg.contextPrompt = ctx.value; await save(); });
    }
  }

  /** 지금 열어 둔 노트를 기준으로 실제 저장될 파일명을 보여 준다. */
  previewText() {
    const pre = this.plugin.activeNoteContext();
    const course = pre.course || '프로젝트';
    const title = this.plugin.settings.titleSource === 'activeNote' && pre.title ? pre.title : '주간 동기화';
    const now = new Date();
    const base = sanitize(applyTemplate(this.plugin.settings.audioNameTemplate, {
      stamp: stampOf(now),
      date: isoDate(now),
      course,
      title,
    }));
    const folder = this.plugin.audioFolderFor({ targetPath: pre.path, course });
    return `${folder}/${base}.webm`;
  }

  /**
   * API 키 입력 칸.
   * 키 값은 가려서 보이고, 이름 앞에 ✅/❌로 인식 여부를, 설명란에 출처(설정/파일)를 보여 준다.
   * "연결 확인" 버튼은 실제로 모델 목록 API를 불러 키가 살아 있는지까지 확인한다.
   */
  keySetting(containerEl, name, provider, help) {
    const field = KeyStore.field(provider);
    const setting = new Setting(containerEl);

    // 타이핑 중에 전체 화면을 다시 그리면 커서가 날아가므로 이 줄만 제자리에서 갱신한다.
    const refresh = () => {
      const found = this.plugin.keys.lookup(provider);
      const has = Boolean(found.key);
      const source = found.source === 'settings' ? '설정에 저장됨'
        : found.source === 'file' ? '키 파일에서 읽음 (아래 칸은 비워 둬도 됩니다)'
          : '키를 찾지 못했습니다';
      setting.setName(`${has ? '✅' : '❌'} ${name}`);
      setting.setDesc(`${source} · ${help}`);
      setting.settingEl.toggleClass('meeting-notes-key-ok', has);
      setting.settingEl.toggleClass('meeting-notes-key-missing', !has);
      return found;
    };
    const initial = refresh();

    setting.addText((t) => {
      t.inputEl.type = 'password';
      t.inputEl.autocomplete = 'off';
      t.inputEl.spellcheck = false;
      t.setPlaceholder(initial.source === 'file' ? '키 파일 사용 중 · 여기 넣으면 이 값이 우선' : '여기에 붙여 넣기')
        .setValue(this.plugin.settings[field] || '')
        .onChange(async (v) => {
          this.plugin.settings[field] = v.trim();
          await this.plugin.saveSettings();
          refresh();
        });
    });

    setting.addButton((b) => b
      .setButtonText('연결 확인')
      .setTooltip('이 키로 모델 목록을 실제로 불러와 봅니다')
      .onClick(async () => {
        b.setButtonText('확인 중…').setDisabled(true);
        try {
          const key = this.plugin.keys.get(provider);
          const api = provider === 'gemini' ? new GeminiProvider(this.plugin) : new OpenAIProvider(this.plugin);
          const models = await api.listModels(key);
          b.setButtonText(`✅ 연결됨 (${models.length}개 모델)`);
          new Notice(`${name} 정상 동작 · 사용 가능한 모델 ${models.length}개`);
        } catch (e) {
          b.setButtonText('❌ 실패');
          new Notice(`${name} 연결 실패\n${e.message}`, 12000);
        } finally {
          b.setDisabled(false);
          window.setTimeout(() => b.setButtonText('연결 확인'), 6000);
        }
      }));
  }

  /** 경로 입력 칸. 존재 여부를 설명란에 바로 보여 준다. */
  pathSetting(containerEl, name, key) {
    const value = expandHome(this.plugin.settings[key]);
    const ok = fs.existsSync(value);
    new Setting(containerEl)
      .setName(name)
      .setDesc(ok ? '✅ 확인됨' : '❌ 파일을 찾을 수 없습니다')
      .addText((t) => t
        .setValue(this.plugin.settings[key])
        .onChange(async (v) => {
          this.plugin.settings[key] = v.trim() || DEFAULT_SETTINGS[key];
          await this.plugin.saveSettings();
        }));
  }

  modelSetting(containerEl, name, key, placeholder) {
    new Setting(containerEl)
      .setName(name)
      .addText((t) => t
        .setPlaceholder(placeholder)
        .setValue(this.plugin.settings[key])
        .onChange(async (v) => {
          this.plugin.settings[key] = v.trim() || placeholder;
          await this.plugin.saveSettings();
        }));
  }
}
