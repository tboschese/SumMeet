"use client";

// UI translations. `en` is the source of truth: TKey is derived from it, so a
// missing or stale key in another locale is a type error, not a silent fallback.
// This is the app's *interface* language — unrelated to the meeting's spoken
// language or the language the insights are written in (both in Settings).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { UiLanguage } from "@summeet/core/schemas";
import { getSettings } from "@/lib/api";

const en = {
  // ── shared ──────────────────────────────────────────────────────────────
  "common.loading": "Loading…",
  "common.settings": "Settings",
  "common.backToMeetings": "← All meetings",
  "common.delete": "Delete",
  "common.retry": "Retry",
  "common.saving": "Saving…",
  "common.saved": "Saved ✓",

  // ── home ────────────────────────────────────────────────────────────────
  "home.tagline": "Your meetings, as decision records.",
  "home.empty.title": "No meetings yet",
  "home.empty.hint": "Record or upload a meeting to see its insights here.",
  "home.apiUnreachable": "Could not reach the API.",
  "home.deleteMeeting": "Delete meeting",
  "home.confirmDelete": "Delete “{title}”? This can't be undone.",
  "home.deleteFailed": "Delete failed.",
  "home.pending.one": "{count} meeting is transcribed but not summarized yet.",
  "home.pending.many": "{count} meetings are transcribed but not summarized yet.",
  "home.summarizeAll": "Summarize all {count}",
  "home.queuing": "Queuing…",
  "home.summarizeFailed": "Could not start summarizing.",
  "home.consent":
    "Recording may require consent. Announce that you're recording and follow local laws and your organization's policy.",

  // ── recorder ────────────────────────────────────────────────────────────
  "rec.record": "● Record meeting",
  "rec.upload": "Upload audio",
  "rec.uploading": "Uploading…",
  "rec.hint": "Pick the meeting tab & enable “Share tab audio”.",
  "rec.stop": "■ Stop",
  "rec.capturing": "capturing",
  "rec.micLabel": "Microphone",
  "rec.micDefault": "default",
  "rec.meter.others": "Others (system audio)",
  "rec.meter.self": "You (microphone)",
  "rec.meter.micDead": "Your microphone is silent — your own voice is not being recorded.",
  "rec.meter.micWeak": "Your microphone is faint — move closer, or pick another input above.",
  "rec.meter.clipping": "Your microphone is clipping — lower its input gain (System Settings → Sound → Input).",
  "rec.meter.systemDead": "No system audio — the other participants are not being recorded.",
  "rec.meter.stale": "The recorder stopped responding.",
  "rec.meter.echo": "Use headphones: on speakers the meeting leaks into your mic and speaker labels become unreliable.",
  "rec.micOn": "Mic on",
  "rec.micOff": "Mic off",
  "rec.badType": "Unsupported file type. Accepted: {list}",
  "rec.tooLarge": "File is too large (max 500 MB).",
  "rec.uploadFailed": "Upload failed.",
  "rec.startFailed": "Could not start recording.",
  "rec.err.TAB_AUDIO_MISSING":
    "You didn't share the tab's audio. Click Record again and enable “Share tab audio” in the picker.",
  "rec.err.DISPLAY_DENIED": "Screen share was cancelled. Click Record and pick the meeting tab.",
  "rec.err.MIC_DENIED": "Microphone access was denied. Without it, your own voice isn't recorded.",
  "rec.err.UNSUPPORTED": "This browser doesn't support tab-audio capture. Use desktop Chrome or Edge.",
  "rec.err.UNKNOWN": "Recording error.",
  "rec.nativeHint": "Captures the system audio + your mic — no tab picker.",
  "rec.nativeFailed": "The native recorder failed.",

  // ── status ──────────────────────────────────────────────────────────────
  "status.UPLOADED": "Queued",
  "status.TRANSCRIBING": "Transcribing",
  "status.TRANSCRIBED": "Transcribed",
  "status.EXTRACTING": "Extracting",
  "status.COMPLETED": "Ready",
  "status.FAILED": "Failed",

  // ── meeting detail ──────────────────────────────────────────────────────
  "detail.loadFailed": "Could not load meeting.",
  "detail.rename": "Rename",
  "detail.renamePrompt": "Rename meeting",
  "detail.renameFailed": "Rename failed.",
  "detail.copyMd": "Copy MD",
  "detail.copied": "Copied ✓",
  "detail.copyFailed": "Could not copy to clipboard.",
  "detail.saveMd": "Save .md",
  "detail.saveMdTitle": "Download as .md to file it in a folder",
  "detail.reextract": "Re-extract",
  "detail.reextracting": "Re-extracting…",
  "detail.reextractFailed": "Re-extract failed.",
  "detail.confirmDelete": "Delete this meeting and its insights? This can't be undone.",
  "detail.deleteFailed": "Delete failed.",
  "detail.failed.title": "Processing failed",
  "detail.failed.unknown": "Unknown error.",
  "detail.busy.TRANSCRIBING": "Transcribing audio…",
  "detail.busy.EXTRACTING": "Extracting insights…",
  "detail.busy.QUEUED": "Queued…",
  "detail.pending.title": "Transcript ready — insights not generated yet",
  "detail.pending.hint":
    "Auto-extract is off, so nothing was sent to the insights engine. Generate the decision record when you want; it uses the engine you picked in Settings.",
  "detail.generate": "Generate insights",
  "detail.generating": "Generating…",
  "detail.transcript": "Full transcript ({count} segments)",
  "detail.jumpToQuote": "Jump to this in the transcript",
  "detail.speaker.self": "You",
  "detail.speaker.others": "Others",
  "detail.minutes": "min",

  // ── section labels (also used for the markdown export headings) ──────────
  "section.tldr": "TL;DR",
  "section.executiveSummary": "Executive summary",
  "section.keyPoints": "Key points",
  "section.myCommitments": "Your commitments",
  "section.actionItems": "Action items",
  "section.decisions": "Decisions",
  "section.openQuestions": "Open questions",
  "section.risks": "Risks & blockers",
  "section.nextSteps": "Next steps",
  "section.metrics": "Numbers mentioned",
  "section.topics": "Topics",
  "section.hint.tldr": "One or two sentences — the whole meeting.",
  "section.hint.executiveSummary": "A single paragraph.",
  "section.hint.keyPoints": "3–7 bullets worth remembering.",
  "section.hint.myCommitments":
    "What you personally committed to. Needs a stereo recording (speaker labels).",
  "section.hint.actionItems": "Commitments, with owner, due date and priority.",
  "section.hint.decisions": "What the group actually settled on, and why.",
  "section.hint.openQuestions": "Raised but left unanswered.",
  "section.hint.risks": "What could derail things, with severity.",
  "section.hint.nextSteps": "What happens after this meeting.",
  "section.hint.metrics": "Figures, targets and deadlines stated.",
  "section.hint.topics": "What was discussed, summarized per topic.",

  // ── insight item fields ─────────────────────────────────────────────────
  "insight.owner": "Owner",
  "insight.due": "Due",
  "insight.why": "Why",
  "insight.askedBy": "Asked by",
  "insight.none": "—",

  // ── settings ────────────────────────────────────────────────────────────
  "settings.title": "Settings",
  "settings.subtitle": "Applies to new recordings and uploads, on every client.",
  "settings.loadFailed": "Could not load settings.",
  "settings.saveFailed": "Could not save.",
  "settings.autosave":
    "Changes save automatically. Existing meetings keep their insights — use Re-extract to redo one.",

  "settings.ui.title": "Interface language",
  "settings.ui.hint": "The language of this app. Doesn't change your meetings or their insights.",

  "settings.engine.title": "Processing engine",
  "settings.engine.hint":
    "Cloud is fast and cheap but sends audio/transcript to Groq. Local is free and fully offline (whisper.cpp + Ollama) — slower, but nothing leaves your machine. You can mix them.",
  "settings.engine.transcription": "Transcription engine",
  "settings.engine.transcriptionHint": "Turns the recording into text.",
  "settings.engine.extraction": "Insights engine",
  "settings.engine.extractionHint": "Turns the transcript into the decision record.",
  "settings.engine.cloudTranscription": "Cloud — Groq Whisper (fast)",
  "settings.engine.localTranscription": "Local — whisper.cpp (free, offline)",
  "settings.engine.cloudExtraction": "Cloud — Groq Llama 3.3 70B (fast)",
  "settings.engine.localExtraction": "Local — Ollama (free, offline)",
  "settings.engine.notInstalled": " — not installed",
  "settings.local.ready": "Local engine ready — whisper.cpp + {model}. Nothing leaves your machine.",
  "settings.local.missing": "Local engine not ready yet. Missing: {list}.",
  "settings.local.needWhisperBin": "`brew install whisper-cpp`",
  "settings.local.needWhisperModel": "a Whisper model at {path}",
  "settings.local.needOllama": "Ollama running (`brew install ollama && ollama serve`)",
  "settings.local.needModel": "`ollama pull {model}`",

  "settings.autoExtract.label": "Generate insights automatically",
  "settings.autoExtract.hint":
    "Off = stop after transcription and wait. A cheap local Whisper can then run on every meeting, while the insights engine (cloud, or a heavy local model) runs only when you ask — and you decide per meeting whether that transcript goes to the cloud.",

  "settings.sections.title": "Summary sections",
  "settings.sections.hint":
    "Pick what the decision record contains and in what order. Sections you leave out aren't generated at all, so a leaner summary is also a cheaper one.",
  "settings.sections.derived": "free — derived",
  "settings.sections.add": "Add a section",
  "settings.sections.dragHint": "Drag the ⠿ handle to reorder, or use ↑↓.",
  "settings.sections.moveUp": "Move up",
  "settings.sections.moveDown": "Move down",
  "settings.sections.dragTitle": "Drag to reorder",
  "settings.sections.keepOne": "Keep at least one section",
  "settings.sections.remove": "Remove",

  "settings.key.title": "Cloud API key (Groq)",
  "settings.key.hint":
    "Needed only for the cloud engine. Stored server-side and never sent back to the browser. Falls back to GROQ_API_KEY in .env when unset.",
  "settings.key.configured": "•••••••• (configured)",
  "settings.key.save": "Save key",
  "settings.key.remove": "Remove",
  "settings.key.saveFailed": "Could not save the key.",
  "settings.key.present": "A key is configured. Cloud engines are available.",
  "settings.key.absent":
    "No key configured — cloud engines will fail. Use the local engine to run free and offline.",

  "settings.glossary.title": "Glossary",
  "settings.glossary.hint":
    "People, product and jargon names. Whisper is conditioned on these so it stops guessing at names, and the extractor spells them right. The single biggest quality win for the local engine.",
  "settings.glossary.placeholder": "Sarah, James, Priya, SumMeet, Kubernetes, ARR, Q3 roadmap",
  "settings.glossary.foot": "Comma- or line-separated. Saved when you click away.",

  "settings.lang.title": "Language",
  "settings.lang.spoken": "Spoken language (transcription)",
  "settings.lang.spokenHint":
    "Telling Whisper the language up front makes the transcript more accurate. Leave on auto-detect if your meetings vary.",
  "settings.lang.autoDetect": "Auto-detect",
  "settings.lang.insights": "Insights language (summary, action items, decisions)",
  "settings.lang.insightsHint":
    "Can differ from the spoken language. Quotes always stay verbatim in the original language.",
  "settings.lang.sameAsMeeting": "Same as the meeting",
} as const;

export type TKey = keyof typeof en;

/** Typed against `en`, so an omitted or renamed key fails the build. */
const ptBR: Record<TKey, string> = {
  "common.loading": "Carregando…",
  "common.settings": "Configurações",
  "common.backToMeetings": "← Todas as reuniões",
  "common.delete": "Excluir",
  "common.retry": "Tentar novamente",
  "common.saving": "Salvando…",
  "common.saved": "Salvo ✓",

  "home.tagline": "Suas reuniões, viradas registro de decisões.",
  "home.empty.title": "Nenhuma reunião ainda",
  "home.empty.hint": "Grave ou envie uma reunião para ver os insights aqui.",
  "home.apiUnreachable": "Não foi possível conectar à API.",
  "home.deleteMeeting": "Excluir reunião",
  "home.confirmDelete": "Excluir “{title}”? Isso não pode ser desfeito.",
  "home.deleteFailed": "Falha ao excluir.",
  "home.pending.one": "{count} reunião foi transcrita, mas ainda não resumida.",
  "home.pending.many": "{count} reuniões foram transcritas, mas ainda não resumidas.",
  "home.summarizeAll": "Resumir todas ({count})",
  "home.queuing": "Enfileirando…",
  "home.summarizeFailed": "Não foi possível iniciar os resumos.",
  "home.consent":
    "Gravar pode exigir consentimento. Avise que está gravando e siga as leis locais e a política da sua organização.",

  "rec.record": "● Gravar reunião",
  "rec.upload": "Enviar áudio",
  "rec.uploading": "Enviando…",
  "rec.hint": "Escolha a aba da reunião e marque “Compartilhar áudio da aba”.",
  "rec.stop": "■ Parar",
  "rec.capturing": "gravando",
  "rec.micLabel": "Microfone",
  "rec.micDefault": "padrão",
  "rec.meter.others": "Outros (áudio do sistema)",
  "rec.meter.self": "Você (microfone)",
  "rec.meter.micDead": "Seu microfone está mudo — sua própria voz não está sendo gravada.",
  "rec.meter.micWeak": "Seu microfone está fraco — aproxime-se, ou escolha outra entrada acima.",
  "rec.meter.clipping": "Seu microfone está distorcendo — reduza o ganho de entrada (Ajustes → Som → Entrada).",
  "rec.meter.systemDead": "Sem áudio do sistema — os outros participantes não estão sendo gravados.",
  "rec.meter.stale": "O gravador parou de responder.",
  "rec.meter.echo": "Use fone de ouvido: no alto-falante a reunião vaza para o seu microfone e a marcação de quem falou fica não confiável.",
  "rec.micOn": "Microfone ligado",
  "rec.micOff": "Microfone desligado",
  "rec.badType": "Tipo de arquivo não suportado. Aceitos: {list}",
  "rec.tooLarge": "Arquivo muito grande (máx. 500 MB).",
  "rec.uploadFailed": "Falha no envio.",
  "rec.startFailed": "Não foi possível iniciar a gravação.",
  "rec.err.TAB_AUDIO_MISSING":
    "Você não compartilhou o áudio da aba. Clique em Gravar de novo e marque “Compartilhar áudio da aba”.",
  "rec.err.DISPLAY_DENIED":
    "O compartilhamento foi cancelado. Clique em Gravar e escolha a aba da reunião.",
  "rec.err.MIC_DENIED":
    "O acesso ao microfone foi negado. Sem ele, a sua própria voz não é gravada.",
  "rec.err.UNSUPPORTED":
    "Este navegador não suporta captura de áudio da aba. Use o Chrome ou Edge no desktop.",
  "rec.err.UNKNOWN": "Erro na gravação.",
  "rec.nativeHint": "Captura o áudio do sistema + seu microfone — sem escolher aba.",
  "rec.nativeFailed": "O gravador nativo falhou.",

  "status.UPLOADED": "Na fila",
  "status.TRANSCRIBING": "Transcrevendo",
  "status.TRANSCRIBED": "Transcrita",
  "status.EXTRACTING": "Extraindo",
  "status.COMPLETED": "Pronta",
  "status.FAILED": "Falhou",

  "detail.loadFailed": "Não foi possível carregar a reunião.",
  "detail.rename": "Renomear",
  "detail.renamePrompt": "Renomear reunião",
  "detail.renameFailed": "Falha ao renomear.",
  "detail.copyMd": "Copiar MD",
  "detail.copied": "Copiado ✓",
  "detail.copyFailed": "Não foi possível copiar.",
  "detail.saveMd": "Salvar .md",
  "detail.saveMdTitle": "Baixar como .md para guardar numa pasta",
  "detail.reextract": "Reprocessar",
  "detail.reextracting": "Reprocessando…",
  "detail.reextractFailed": "Falha ao reprocessar.",
  "detail.confirmDelete": "Excluir esta reunião e seus insights? Isso não pode ser desfeito.",
  "detail.deleteFailed": "Falha ao excluir.",
  "detail.failed.title": "O processamento falhou",
  "detail.failed.unknown": "Erro desconhecido.",
  "detail.busy.TRANSCRIBING": "Transcrevendo o áudio…",
  "detail.busy.EXTRACTING": "Extraindo os insights…",
  "detail.busy.QUEUED": "Na fila…",
  "detail.pending.title": "Transcrição pronta — insights ainda não gerados",
  "detail.pending.hint":
    "A extração automática está desligada, então nada foi enviado ao motor de insights. Gere o registro de decisões quando quiser; será usado o motor escolhido nas Configurações.",
  "detail.generate": "Gerar insights",
  "detail.generating": "Gerando…",
  "detail.transcript": "Transcrição completa ({count} trechos)",
  "detail.jumpToQuote": "Ir até este trecho na transcrição",
  "detail.speaker.self": "Você",
  "detail.speaker.others": "Outros",
  "detail.minutes": "min",

  "section.tldr": "Resumo em 1 linha",
  "section.executiveSummary": "Resumo executivo",
  "section.keyPoints": "Pontos principais",
  "section.myCommitments": "Seus compromissos",
  "section.actionItems": "Itens de ação",
  "section.decisions": "Decisões",
  "section.openQuestions": "Perguntas em aberto",
  "section.risks": "Riscos e bloqueios",
  "section.nextSteps": "Próximos passos",
  "section.metrics": "Números mencionados",
  "section.topics": "Tópicos",
  "section.hint.tldr": "Uma ou duas frases — a reunião inteira.",
  "section.hint.executiveSummary": "Um único parágrafo.",
  "section.hint.keyPoints": "3 a 7 pontos que valem ser lembrados.",
  "section.hint.myCommitments":
    "O que você pessoalmente se comprometeu a fazer. Precisa de gravação em estéreo (com falantes identificados).",
  "section.hint.actionItems": "Compromissos, com responsável, prazo e prioridade.",
  "section.hint.decisions": "O que o grupo de fato decidiu, e por quê.",
  "section.hint.openQuestions": "Levantadas, mas deixadas sem resposta.",
  "section.hint.risks": "O que pode atrapalhar, com gravidade.",
  "section.hint.nextSteps": "O que acontece depois desta reunião.",
  "section.hint.metrics": "Números, metas e prazos citados.",
  "section.hint.topics": "O que foi discutido, resumido por tópico.",

  "insight.owner": "Responsável",
  "insight.due": "Prazo",
  "insight.why": "Por quê",
  "insight.askedBy": "Perguntado por",
  "insight.none": "—",

  "settings.title": "Configurações",
  "settings.subtitle": "Vale para novas gravações e envios, em qualquer cliente.",
  "settings.loadFailed": "Não foi possível carregar as configurações.",
  "settings.saveFailed": "Não foi possível salvar.",
  "settings.autosave":
    "As mudanças salvam sozinhas. Reuniões existentes mantêm os insights — use Reprocessar para refazer uma.",

  "settings.ui.title": "Idioma da interface",
  "settings.ui.hint":
    "O idioma deste app. Não muda suas reuniões nem os insights delas.",

  "settings.engine.title": "Motor de processamento",
  "settings.engine.hint":
    "Nuvem é rápido e barato, mas envia áudio/transcrição para a Groq. Local é gratuito e totalmente offline (whisper.cpp + Ollama) — mais lento, mas nada sai da sua máquina. Você pode misturar os dois.",
  "settings.engine.transcription": "Motor de transcrição",
  "settings.engine.transcriptionHint": "Transforma a gravação em texto.",
  "settings.engine.extraction": "Motor de insights",
  "settings.engine.extractionHint": "Transforma a transcrição no registro de decisões.",
  "settings.engine.cloudTranscription": "Nuvem — Groq Whisper (rápido)",
  "settings.engine.localTranscription": "Local — whisper.cpp (grátis, offline)",
  "settings.engine.cloudExtraction": "Nuvem — Groq Llama 3.3 70B (rápido)",
  "settings.engine.localExtraction": "Local — Ollama (grátis, offline)",
  "settings.engine.notInstalled": " — não instalado",
  "settings.local.ready":
    "Motor local pronto — whisper.cpp + {model}. Nada sai da sua máquina.",
  "settings.local.missing": "Motor local ainda não está pronto. Falta: {list}.",
  "settings.local.needWhisperBin": "`brew install whisper-cpp`",
  "settings.local.needWhisperModel": "um modelo do Whisper em {path}",
  "settings.local.needOllama": "o Ollama rodando (`brew install ollama && ollama serve`)",
  "settings.local.needModel": "`ollama pull {model}`",

  "settings.autoExtract.label": "Gerar insights automaticamente",
  "settings.autoExtract.hint":
    "Desligado = para após a transcrição e espera. Assim um Whisper local barato roda em toda reunião, enquanto o motor de insights (nuvem, ou um modelo local pesado) só roda quando você pedir — e você decide, reunião a reunião, se aquela transcrição vai para a nuvem.",

  "settings.sections.title": "Seções do resumo",
  "settings.sections.hint":
    "Escolha o que o registro de decisões contém e em que ordem. Seções que você deixa de fora nem são geradas, então um resumo mais enxuto também sai mais barato.",
  "settings.sections.derived": "grátis — derivada",
  "settings.sections.add": "Adicionar seção",
  "settings.sections.dragHint": "Arraste pela alça ⠿ para reordenar, ou use ↑↓.",
  "settings.sections.moveUp": "Mover para cima",
  "settings.sections.moveDown": "Mover para baixo",
  "settings.sections.dragTitle": "Arraste para reordenar",
  "settings.sections.keepOne": "Mantenha ao menos uma seção",
  "settings.sections.remove": "Remover",

  "settings.key.title": "Chave de API da nuvem (Groq)",
  "settings.key.hint":
    "Necessária só para o motor de nuvem. Fica guardada no servidor e nunca é devolvida ao navegador. Se não definida, usa GROQ_API_KEY do .env.",
  "settings.key.configured": "•••••••• (configurada)",
  "settings.key.save": "Salvar chave",
  "settings.key.remove": "Remover",
  "settings.key.saveFailed": "Não foi possível salvar a chave.",
  "settings.key.present": "Há uma chave configurada. Os motores de nuvem estão disponíveis.",
  "settings.key.absent":
    "Nenhuma chave configurada — os motores de nuvem vão falhar. Use o motor local para rodar grátis e offline.",

  "settings.glossary.title": "Glossário",
  "settings.glossary.hint":
    "Nomes de pessoas, produtos e jargões. O Whisper é condicionado por eles e para de chutar nomes, e a extração os escreve corretamente. É o maior ganho de qualidade para o motor local.",
  "settings.glossary.placeholder": "Sarah, James, Priya, SumMeet, Kubernetes, ARR, roadmap Q3",
  "settings.glossary.foot":
    "Separe por vírgula ou por linha. Salva quando você clica fora.",

  "settings.lang.title": "Idioma",
  "settings.lang.spoken": "Idioma falado (transcrição)",
  "settings.lang.spokenHint":
    "Informar o idioma ao Whisper deixa a transcrição mais precisa. Deixe em detecção automática se suas reuniões variam.",
  "settings.lang.autoDetect": "Detectar automaticamente",
  "settings.lang.insights": "Idioma dos insights (resumo, itens de ação, decisões)",
  "settings.lang.insightsHint":
    "Pode ser diferente do idioma falado. As citações permanecem sempre no idioma original.",
  "settings.lang.sameAsMeeting": "Igual ao da reunião",
};

const DICTS: Record<UiLanguage, Record<TKey, string>> = { en, "pt-BR": ptBR };

export const UI_LANGUAGES: { code: UiLanguage; label: string }[] = [
  { code: "en", label: "English" },
  { code: "pt-BR", label: "Português (Brasil)" },
];

export type TFunction = (key: TKey, params?: Record<string, string | number>) => string;

const STORAGE_KEY = "summeet.uiLanguage";

const I18nContext = createContext<{ lang: UiLanguage; t: TFunction; setLang: (l: UiLanguage) => void }>({
  lang: "en",
  t: (k) => en[k],
  setLang: () => {},
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  // Read the cached choice synchronously on mount so the first paint isn't in
  // the wrong language; the server remains the source of truth.
  const [lang, setLangState] = useState<UiLanguage>("en");

  useEffect(() => {
    const cached = window.localStorage.getItem(STORAGE_KEY);
    if (cached === "en" || cached === "pt-BR") setLangState(cached);
    getSettings()
      .then((s) => {
        setLangState(s.uiLanguage);
        window.localStorage.setItem(STORAGE_KEY, s.uiLanguage);
      })
      .catch(() => {
        /* offline API: keep the cached choice */
      });
  }, []);

  const setLang = useCallback((next: UiLanguage) => {
    setLangState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const t = useCallback<TFunction>(
    (key, params) => {
      let text: string = DICTS[lang][key] ?? en[key];
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          text = text.replaceAll(`{${k}}`, String(v));
        }
      }
      return text;
    },
    [lang],
  );

  const value = useMemo(() => ({ lang, t, setLang }), [lang, t, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

/** Convenience: most components only need `t`. */
export function useT(): TFunction {
  return useContext(I18nContext).t;
}
