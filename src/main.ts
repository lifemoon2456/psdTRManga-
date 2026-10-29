import "./style.css";
import JSZip from "jszip";
import { DefaultConfig, FONT_PRESETS } from "./lib/configs";
import {
  allFontPresets,
  customFontsPersistenceError,
  getCustomFontDownload,
  importCustomFont,
  listCustomFonts,
  loadCustomFonts,
  removeCustomFont,
} from "./lib/custom-fonts";
import {
  analyzePage,
  renderPage,
  type PageAnalysis,
  type PipelineStage,
} from "./lib/pipeline";
import {
  PROJECT_FILE_EXTENSION,
  PROJECT_VERSION,
  applyProjectSettings,
  exportProjectFile,
  importProjectFile,
  loadProjectSnapshot,
  MAX_PROJECT_PAGES,
  projectSettingsFromApp,
  projectStatus,
  saveProjectSnapshot,
  SUPPORTED_IMAGE_TYPES,
  type ProjectPage,
  type ProjectSnapshot,
} from "./lib/project";
import { downloadBytes } from "./lib/psd";
import {
  isTextOnlyTranslation,
  isVisionTranslation,
  translatePage,
  type TranslationSettings,
} from "./lib/translation";
import {
  bubbleId as buildBubbleId,
  planTextBatches,
  type TranslationBubbleInput,
} from "./lib/translation/batching";
import { clearTranslationCache, countTranslationCache } from "./lib/translation/cache";
import {
  isAbortError,
  QuotaExhaustedError,
  RequestAbortedError,
  RequestManager,
  type RequestManagerStats,
} from "./lib/translation/request-manager";
import { translateBubbles } from "./lib/translation/smart-batch";
import {
  baseName,
  clamp,
  downloadBlob,
  downloadDataUrl,
  escapeHtml,
  formatBytes,
  loadImageMeta,
  toast,
} from "./ui/dom";
import {
  loadSettings,
  saveSettings,
  selectedFont,
  toPipelineSettings,
  validateSettings,
  type AppSettings,
  type PageJob,
  type PageStatus,
} from "./ui/state";

type PreviewTab = "original" | "cleaned" | "final";
type ArchiveFormat = "psd" | "png" | "both";

interface BatchStats {
  pagesTotal: number;
  pagesAnalyzed: number;
  extractedBubbles: number;
  totalBubbles: number;
  translatedBubbles: number;
  cacheHits: number;
  ocrFailures: number;
  visionFallbacks: number;
  batchesTotal: number;
  batchesDone: number;
  remainingBatches: number;
  requests: number;
  promptTokens: number;
  candidatesTokens: number;
  totalTokens: number;
  errors: number;
  missingBubbles: number;
}

function prepareSinglePageRun(phase: "analyze" | "translate" | "render" = "analyze"): void {
  state.batchStats = emptyBatchStats(1);
  state.batchTotal = 1;
  state.batchIndex = 0;
  state.batchPhase = phase;
  state.apiNote = "";
  renderBatchMetrics();
}

function emptyBatchStats(pagesTotal = 0): BatchStats {
  return {
    pagesTotal,
    pagesAnalyzed: 0,
    extractedBubbles: 0,
    totalBubbles: 0,
    translatedBubbles: 0,
    cacheHits: 0,
    ocrFailures: 0,
    visionFallbacks: 0,
    batchesTotal: 0,
    batchesDone: 0,
    remainingBatches: 0,
    requests: 0,
    promptTokens: 0,
    candidatesTokens: 0,
    totalTokens: 0,
    errors: 0,
    missingBubbles: 0,
  };
}

const state = {
  pages: [] as PageJob[],
  selectedId: null as string | null,
  settings: loadSettings(),
  busy: false,
  status: "جاهز. أضف صفحات مانجا للبدء.",
  progress: 0,
  previewTab: "original" as PreviewTab,
  boxEditMode: false,
  selectedBoxIndex: null as number | null,
  projectSaving: false,
  projectSavedAt: null as number | null,
  projectError: "",
  restoringProject: false,
  batchIndex: 0,
  batchTotal: 0,
  batchPhase: "analyze" as "analyze" | "translate" | "render",
  batchAbort: null as AbortController | null,
  batchStats: emptyBatchStats(),
  apiStats: null as RequestManagerStats | null,
  apiNote: "",
};

let nextId = 1;
let projectSaveTimer: number | null = null;
let projectSavePromise: Promise<boolean> | null = null;
let projectSaveQueued = false;
const importedPaths = new WeakMap<File, string>();

const BOX_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type BoxHandle = (typeof BOX_HANDLES)[number];
const BOX_MIN_SIZE = 10;

interface BoxDragState {
  mode: "draw" | "move" | "resize";
  pointerId: number;
  jobId: string;
  overlay: HTMLElement;
  boxIndex: number | null;
  handle: BoxHandle | null;
  startX: number;
  startY: number;
  startBox: Bbox | null;
  currentBox: Bbox | null;
  draft: HTMLElement | null;
  moved: boolean;
  pageWidth: number;
  pageHeight: number;
}

let boxDrag: BoxDragState | null = null;

const STAGE_PROGRESS: Record<PipelineStage, number> = {
  detect: 12,
  ocr: 36,
  translate: 50,
  inpaint: 70,
  compose: 86,
  psd: 95,
  done: 100,
};

const STATUS_LABEL: Record<PageStatus, string> = {
  queued: "بانتظار التحليل",
  analyzing: "جاري التحليل",
  ready: "جاهزة للتركيب",
  rendering: "جاري التركيب",
  done: "PSD جاهز",
  error: "خطأ",
};

function selectedJob(): PageJob | null {
  return state.pages.find((page) => page.id === state.selectedId) ?? null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function pageCountText(count: number, genitive = false): string {
  if (count === 1) return "صفحة واحدة";
  if (count === 2) return genitive ? "صفحتين" : "صفحتان";
  if (count >= 3 && count <= 10) return `${count} صفحات`;
  return `${count} صفحة`;
}

function renderShell(): void {
  const root = document.getElementById("app");
  if (!root) throw new Error("Missing #app");

  root.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">م</div>
          <div>
            <h1>Manga PSD Studio</h1>
            <p>ترجمة المانجا الإنجليزية واليابانية إلى العربية مع تصدير PSD بطبقات نص قابلة للتعديل</p>
          </div>
        </div>
        <div class="top-actions">
          <button id="analyze-all" class="ghost" title="كشف المناطق واستخراج النص محليًا وترجمته دون تركيب PSD">تحليل الكل</button>
          <button id="process-all" class="primary" title="تحليل وترجمة وتركيب PSD لكل الصفحات">ترجمة الكل</button>
          <button id="stop-batch" class="danger" hidden title="إيقاف بعد الدفعة الحالية">إيقاف</button>
          <select id="download-format" aria-label="صيغة حزمة التصدير" title="صيغة الملفات داخل ZIP">
            <option value="psd">PSD قابل للتعديل</option>
            <option value="png">PNG نهائي</option>
            <option value="both">PSD وPNG</option>
          </select>
          <button
            id="download-all"
            class="primary"
            title="تصدير كل الصفحات المعالجة داخل ملف ZIP واحد"
          >تصدير جميع الصفحات (ZIP)</button>
        </div>
      </header>

      <div class="project-bar">
        <div class="project-bar-info">
          <strong>المشروع</strong>
          <span id="project-state" class="project-state" role="status">الحفظ التلقائي مفعّل</span>
        </div>
        <div class="project-bar-actions">
          <button class="small" id="save-project">حفظ الآن</button>
          <button class="small" id="export-project">تصدير المشروع</button>
          <button class="small" id="import-project">استيراد مشروع</button>
          <input
            id="project-input"
            type="file"
            accept=".mpsproj,.zip,application/zip,application/x-zip-compressed"
            hidden
          />
        </div>
      </div>

      <div class="workspace">
        <main class="main">
          <section class="panel">
            <div class="panel-head">
              <h2>إضافة صفحات</h2>
              <span class="badge">صور PNG / JPG / WebP / GIF / AVIF</span>
            </div>
            <div class="panel-body">
              <div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="اختيار صفحات مانجا أو مجلد كامل">
                <h3>اسحب صفحات المانجا أو مجلدًا كاملًا هنا</h3>
                <p>اختر مجلد الصفحات أو عدة صور مرة واحدة. الصفحات لا تُرفع إلى أي خادم من هذا التطبيق.</p>
                <div class="dropzone-actions">
                  <button type="button" class="primary" id="pick-files">اختيار الصفحات</button>
                  <button type="button" id="pick-folder">اختيار مجلد</button>
                </div>
                <div class="hint">تُرتّب الصفحات تلقائيًا حسب اسم الملف. بعد إضافة المجلد اضغط «ترجمة الكل» في الأعلى.</div>
                <div class="hint">أول تشغيل قد ينزّل موديلات الكشف والتنظيف. انتظر حتى يكتمل التنزيل.</div>
              </div>
              <input id="file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple hidden />
              <input
                id="folder-input"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                webkitdirectory
                multiple
                hidden
              />

              <div style="margin-top: 14px">
                <div class="status-line">
                  <strong id="status-text">جاهز</strong>
                  <span id="progress-text">0%</span>
                </div>
                <div class="progress" style="margin-top: 7px"><i id="progress-bar"></i></div>
                <div id="batch-metrics" class="batch-metrics" hidden></div>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2>الصفحات <span id="page-count" class="badge">0</span></h2>
              <div class="pages-head-actions">
                <div class="pages-navigation" aria-label="التنقل بين الصفحات">
                  <button class="small" id="pages-next-page" type="button" disabled>التالي</button>
                  <span id="pages-page-position" class="preview-page-position" aria-live="polite">—</span>
                  <button class="small" id="pages-previous-page" type="button" disabled>السابق</button>
                </div>
                <button class="small" id="add-folder">إضافة مجلد</button>
                <button class="small" id="add-more">إضافة صور</button>
                <button class="small danger" id="clear-all">مسح الكل</button>
              </div>
            </div>
            <div class="panel-body">
              <div id="pages-grid"></div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2>المعاينة</h2>
              <div class="preview-head-actions">
                <div class="preview-navigation" aria-label="التنقل بين الصفحات">
                  <button
                    class="small"
                    id="preview-next-page"
                    type="button"
                    title="الصفحة التالية"
                    aria-label="الصفحة التالية"
                    disabled
                  >التالي</button>
                  <span id="preview-page-position" class="preview-page-position" aria-live="polite">—</span>
                  <button
                    class="small"
                    id="preview-previous-page"
                    type="button"
                    title="الصفحة السابقة"
                    aria-label="الصفحة السابقة"
                    disabled
                  >السابق</button>
                </div>
                <div class="preview-tabs" id="preview-tabs">
                  <button class="small active" data-tab="original">الأصلية</button>
                  <button class="small" data-tab="cleaned" disabled>المنظفة</button>
                  <button class="small" data-tab="final" disabled>النهائية</button>
                </div>
                <button class="small" id="toggle-box-editor" disabled>تحرير الصناديق</button>
              </div>
            </div>
            <div class="panel-body">
              <div class="preview-wrap">
                <div class="preview-stage" id="preview-stage">
                  <div class="empty">اختر صفحة لعرض المعاينة.</div>
                </div>
                <div class="preview-side" id="preview-side"></div>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2>النصوص والترجمة <span id="translation-count" class="badge">0</span></h2>
              <div style="display:flex; gap:6px; flex-wrap:wrap">
                <button class="small" id="reanalyze-selected">إعادة تحليل</button>
                <button class="small" id="retranslate-selected">ترجمة المناطق الحالية</button>
                <button class="small" id="render-selected">تركيب وتحديث PSD</button>
                <button class="small primary" id="download-selected">تنزيل PSD</button>
              </div>
            </div>
            <div class="panel-body" id="translations-body"></div>
          </section>
        </main>

        <aside class="sidebar">
          <section class="panel">
            <div class="panel-head"><h2>الإعدادات</h2></div>
            <div class="panel-body" id="settings-body"></div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>كيف يعمل؟</h2></div>
            <div class="panel-body" id="help-body"></div>
          </section>
        </aside>
      </div>

      <div class="footer-note">
        © 2026 Manga PSD Studio contributors — AGPL-3.0-or-later.
        يتضمن كودًا معدّلًا من Libre Manga Translator (AGPL) وComicTL (MIT).
        <a href="https://github.com/lifemoon2456/psdTRManga-" target="_blank" rel="noreferrer">الكود المصدري</a>
        · <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">نص الترخيص</a>.
        راجع <code>LICENSE</code> و<code>NOTICE</code> و<code>THIRD_PARTY_NOTICES.md</code> في المستودع.
      </div>
      <div class="toast-stack" id="toasts"></div>
    </div>
  `;
}

function renderSettings(): void {
  const body = document.getElementById("settings-body");
  if (!body) return;

  const s = state.settings;
  const font = selectedFont(s);

  const engineOptions = [
    ["gemini", "Gemini — OCR محلي + ترجمة نصية (موصى به)"],
    ["openai", "OpenAI-compatible Vision — محلي أو سحابي"],
    ["manual", "يدوي — كشف وOCR ثم أكتب الترجمة"],
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}" ${s.engine === value ? "selected" : ""}>${label}</option>`,
    )
    .join("");

  const sourceOptions = ["Japanese", "English", "Auto-Detect"]
    .map(
      (value) =>
        `<option value="${value}" ${s.sourceLang === value ? "selected" : ""}>${
          value === "Japanese" ? "اليابانية" : value === "English" ? "الإنجليزية" : "كشف تلقائي"
        }</option>`,
    )
    .join("");

  const detectionOptions = DefaultConfig.detectionModels
    .map(
      (model) =>
        `<option value="${escapeHtml(model.id)}" ${
          s.detectionModel === model.id ? "selected" : ""
        }>${escapeHtml(model.label)} — ${escapeHtml(model.size)}</option>`,
    )
    .join("");

  const customFonts = listCustomFonts();
  const fontOptions = allFontPresets()
    .map(
      (item) =>
        `<option value="${escapeHtml(item.id)}" ${
          s.fontId === item.id ? "selected" : ""
        }>${escapeHtml(item.label)}</option>`,
    )
    .join("");

  const customFontRows =
    customFonts.length > 0
      ? customFonts
          .map((item) => {
            const isSelected = s.fontId === item.id;
            return `
              <div class="custom-font-row${isSelected ? " selected" : ""}">
                <div class="custom-font-info">
                  <div class="custom-font-title">
                    <strong>${escapeHtml(item.label)}</strong>
                    ${isSelected ? `<span class="badge ok">محدد</span>` : ""}
                  </div>
                  <div class="custom-font-sample" dir="rtl" style="font-family: ${escapeHtml(item.cssStack)}">
                    أبجد هوز حطي
                  </div>
                  <div class="hint">
                    ${escapeHtml(item.fileName)} · ${formatBytes(item.size)} ·
                    PostScript: <code>${escapeHtml(item.postscriptName)}</code>
                  </div>
                </div>
                <div class="custom-font-actions">
                  ${
                    isSelected
                      ? ""
                      : `<button type="button" class="small" data-font-action="select" data-font-id="${escapeHtml(item.id)}">استخدام</button>`
                  }
                  <button type="button" class="small" data-font-action="download" data-font-id="${escapeHtml(item.id)}">تنزيل</button>
                  <button type="button" class="small danger" data-font-action="delete" data-font-id="${escapeHtml(item.id)}">حذف</button>
                </div>
              </div>
            `;
          })
          .join("")
      : `<div class="empty small">لم تُضف خطوطًا مخصصة بعد.</div>`;

  const fontHint = font.custom
    ? `خط مخصص محفوظ في هذا المتصفح. <button type="button" class="link-button" data-font-action="download" data-font-id="${escapeHtml(font.id)}">تنزيل ملف الخط</button> ثم ثبّته على جهازك قبل فتح PSD.`
    : font.file
      ? `<a href="${escapeHtml(font.file)}" download>تنزيل ملف الخط</a> ثم ثبّته على جهازك قبل فتح PSD.`
      : "ثبّت الخط على جهازك قبل فتح PSD.";

  const persistenceError = customFontsPersistenceError();

  const geminiFields = `
    <div class="field">
      <label for="gemini-key">مفتاح Gemini API</label>
      <input id="gemini-key" data-setting="geminiApiKey" type="password" autocomplete="off"
        autocapitalize="none" autocorrect="off" spellcheck="false" dir="ltr"
        value="${escapeHtml(s.geminiApiKey)}" placeholder="AIza..." />
      <div class="hint">يبقى في هذا المتصفح فقط ولا يُضمّن في ملف المشروع.</div>
    </div>
    <div class="field">
      <label for="gemini-model">موديل Gemini</label>
      <input id="gemini-model" data-setting="geminiModel" list="gemini-model-list"
        value="${escapeHtml(s.geminiModel)}" placeholder="gemini-2.5-flash-lite" />
      <datalist id="gemini-model-list">
        <option value="gemini-2.5-flash-lite"></option>
        <option value="gemini-2.5-flash"></option>
        <option value="gemini-2.5-pro"></option>
        <option value="gemini-2.0-flash"></option>
      </datalist>
      <div class="hint">الافتراضي flash-lite لأنه أرخص وأسرع لترجمة نصوص فقط. يمكنك تغييره في أي وقت.</div>
    </div>
    <div class="field">
      <label for="gemini-mode">طريقة Gemini</label>
      <select id="gemini-mode" data-setting="geminiMode">
        <option value="text" ${s.geminiMode === "text" ? "selected" : ""}>نص فقط — OCR محلي (موصى به)</option>
        <option value="vision" ${s.geminiMode === "vision" ? "selected" : ""}>Vision — يرسل صورة الصفحة (اختياري)</option>
      </select>
      <div class="hint">في وضع النص لا تُرسل أي صورة أو Base64 إلى Gemini. Vision يبقى متاحًا كخيار صريح أو كبديل عند فشل OCR.</div>
    </div>
    <div class="field">
      <label for="gemini-base">عنوان Gemini API (متقدم)</label>
      <input id="gemini-base" data-setting="geminiBaseUrl" type="text"
        value="${escapeHtml(s.geminiBaseUrl)}" placeholder="https://generativelanguage.googleapis.com/v1beta" />
      <div class="hint">يمكن تغييره لخادم اختبار متوافق. لا تستخدم عنوانًا غير موثوق مع مفتاحك.</div>
    </div>

    <details class="settings-group advanced-settings">
      <summary>خيارات الترجمة المتقدمة</summary>
      <div class="settings-group-content">
        <div class="settings-subtitle">Smart Batch وإدارة الطلبات</div>

    <div class="field">
      <label class="row">
        <input data-setting="smartBatch" type="checkbox" ${s.smartBatch ? "checked" : ""} />
        تجميع الصفحات في دفعات ذكية (Smart Batch)
      </label>
      <div class="hint">افتراضيًا 4 صفحات لكل دفعة. تُقسَّم الدفعة تلقائيًا إذا تجاوزت ميزانية التوكنات.</div>
    </div>
    <div class="field-row">
      <div class="field">
        <label for="batch-pages">صفحات/دفعة</label>
        <input id="batch-pages" data-setting="batchPages" type="number" min="1" max="8" step="1" value="${s.batchPages}" />
      </div>
      <div class="field">
        <label for="batch-tokens">ميزانية التوكنات</label>
        <input id="batch-tokens" data-setting="batchTokenBudget" type="number" min="1000" max="1000000" step="500" value="${s.batchTokenBudget}" />
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label for="max-concurrent">طلبات متزامنة</label>
        <input id="max-concurrent" data-setting="maxConcurrentRequests" type="number" min="1" max="4" step="1" value="${s.maxConcurrentRequests}" />
      </div>
      <div class="field">
        <label for="max-retries">إعادة المحاولة</label>
        <input id="max-retries" data-setting="maxRetries" type="number" min="0" max="10" step="1" value="${s.maxRetries}" />
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <label for="rpm-limit">حد RPM (0 = بلا حد محلي)</label>
        <input id="rpm-limit" data-setting="rpmLimit" type="number" min="0" step="1" value="${s.rpmLimit}" />
      </div>
      <div class="field">
        <label for="tpm-limit">حد TPM (0 = بلا حد محلي)</label>
        <input id="tpm-limit" data-setting="tpmLimit" type="number" min="0" step="100" value="${s.tpmLimit}" />
      </div>
    </div>
    <div class="hint">لا توجد حدود مجانية مبرمجة داخل التطبيق. اتركها 0 وحددها فقط إذا كانت خطتك تتطلب ذلك.</div>

    <div class="field">
      <label class="row">
        <input data-setting="useCountTokens" type="checkbox" ${s.useCountTokens ? "checked" : ""} />
        استخدام countTokens قبل كل دفعة (طلب إضافي)
      </label>
    </div>
    <div class="field">
      <label class="row">
        <input data-setting="cacheEnabled" type="checkbox" ${s.cacheEnabled ? "checked" : ""} />
        حفظ الترجمة في ذاكرة IndexedDB وإعادة استخدامها
      </label>
      <div class="hint">المفتاح يعتمد على النص واللغة والموديل والإعدادات والسياق. تعديل فقاعة واحدة لا يلغي ترجمات الصفحة.</div>
      <div class="cache-row">
        <span id="translation-cache-count" class="hint">جارٍ حساب الذاكرة…</span>
        <button type="button" class="small danger" id="clear-translation-cache">مسح الذاكرة</button>
      </div>
    </div>
    <div class="field">
      <label class="row">
        <input data-setting="useVisionOnOcrFailure" type="checkbox" ${s.useVisionOnOcrFailure ? "checked" : ""} />
        استخدام Vision تلقائيًا للفقرات التي فشل OCR في قراءتها
      </label>
      <div class="hint">متوقف افتراضيًا. عند تفعيله يُرسل فقط صندوق/صناديق فشل OCR إلى Gemini Vision.</div>
    </div>
    <div class="field">
      <label for="series-summary">سياق السلسلة/الفصل (اختياري)</label>
      <textarea id="series-summary" class="source-input" data-setting="seriesSummary"
        placeholder="أسماء الشخصيات، العلاقات، نبرة العمل، ملخص الفصل…">${escapeHtml(s.seriesSummary)}</textarea>
      <div class="hint">يُعاد استخدامه في كل دفعة لتحسين الاتساق وتقليل تكرار الشرح.</div>
    </div>
    <div class="field">
      <label for="glossary">قاموس المصطلحات (اختياري)</label>
      <textarea id="glossary" class="source-input" data-setting="glossary"
        placeholder="اسم ياباني = الاسم العربي&#10;مصطلح = ترجمة ثابتة">${escapeHtml(s.glossary)}</textarea>
    </div>
      </div>
    </details>
  `;

  const openaiFields = `
    <div class="field">
      <label for="openai-base">عنوان الخادم (OpenAI-compatible)</label>
      <input id="openai-base" data-setting="openaiBaseUrl" type="text"
        value="${escapeHtml(s.openaiBaseUrl)}" placeholder="http://127.0.0.1:11434/v1" />
    </div>
    <div class="field">
      <label for="openai-key">مفتاح API (اختياري للمحلي)</label>
      <input id="openai-key" data-setting="openaiApiKey" type="password" autocomplete="off"
        value="${escapeHtml(s.openaiApiKey)}" placeholder="اتركه فارغًا لـ Ollama / LM Studio" />
    </div>
    <div class="field">
      <label for="openai-model">اسم الموديل</label>
      <input id="openai-model" data-setting="openaiModel" type="text"
        value="${escapeHtml(s.openaiModel)}" placeholder="qwen2.5vl:7b" />
      <div class="hint">يجب أن يدعم الموديل الصور (Vision) وصيغة image_url في OpenAI-compatible API.</div>
    </div>
    <div class="field">
      <label class="row">
        <input data-setting="openaiJsonMode" type="checkbox" ${s.openaiJsonMode ? "checked" : ""} />
        طلب JSON mode من الخادم
      </label>
      <div class="hint">فعّله مع OpenAI. اتركه متوقفًا مع بعض خوادم Ollama القديمة.</div>
    </div>
  `;

  const engineSpecific =
    s.engine === "gemini"
      ? geminiFields
      : s.engine === "openai"
        ? openaiFields
        : `<div class="notice info">وضع يدوي: سيتم كشف مناطق النص فقط، ثم تكتب الترجمة العربية في الجدول وتضغط «تركيب وتحديث PSD».</div>`;

  body.innerHTML = `
    <details class="settings-group" open>
      <summary>الترجمة واللغة</summary>
      <div class="settings-group-content">
        <div class="field">
          <label for="engine">محرك الترجمة</label>
          <select id="engine" data-setting="engine">${engineOptions}</select>
        </div>
        ${engineSpecific}
        <div class="field">
          <label for="source-lang">لغة المصدر</label>
          <select id="source-lang" data-setting="sourceLang">${sourceOptions}</select>
          <div class="hint">الهدف ثابت: العربية.</div>
        </div>
        <div class="field">
          <label for="temperature">إبداعية الترجمة (temperature)</label>
          <input id="temperature" data-setting="temperature" type="number" min="0" max="2" step="0.05"
            value="${s.temperature}" />
          <div class="hint">0.2–0.4 مناسبة للمانجا. القيم الأعلى قد تتصرف بحرية أكبر.</div>
        </div>
      </div>
    </details>

    <details class="settings-group">
      <summary>الكشف والتنظيف</summary>
      <div class="settings-group-content">
        <div class="field">
      <label for="detection-model">موديل كشف النص</label>
      <select id="detection-model" data-setting="detectionModel">${detectionOptions}</select>
      <div class="hint">Comic Text Detector أدق في النص الياباني والصناديق، وRT-DETR أخف.</div>
    </div>

    <div class="field">
      <label for="confidence">حد الثقة في الكشف</label>
      <input id="confidence" data-setting="detectionMinConfidence" type="number" min="0.1" max="0.9"
        step="0.05" value="${s.detectionMinConfidence}" />
      <div class="hint">قلّل القيمة لاكتشاف نص خفيف، وارفعها لتقليل الضوضاء.</div>
    </div>

    <div class="field">
      <label for="inpaint-method">طريقة التنظيف</label>
      <select id="inpaint-method" data-setting="inpaintMethod">
        <option value="quality" ${s.inpaintMethod === "quality" ? "selected" : ""}>LaMa — جودة أعلى (أبطأ)</option>
        <option value="fast" ${s.inpaintMethod === "fast" ? "selected" : ""}>سريع بدون موديل إضافي</option>
      </select>
      <div class="hint">LaMa ينزّل موديلًا إضافيًا (~207 MB) في أول مرة، وهو الأنظف داخل الفقاعات الداكنة. المسار السريع للمعاينة فقط وقد يترك آثارًا.</div>
    </div>
      </div>
    </details>

    <details class="settings-group">
      <summary>النص والتصدير</summary>
      <div class="settings-group-content">
        <div class="field">
      <label for="font">خط النص العربي</label>
      <select id="font" data-setting="fontId">${fontOptions}</select>
      <div class="font-preview" dir="rtl" style="font-family: ${escapeHtml(font.cssStack)}">
        أبجد هوز — نص عربي
      </div>
      <div class="hint">${fontHint}</div>
    </div>

    <div class="font-manager">
      <div class="font-manager-head">
        <div>
          <strong>خطوط مخصصة</strong>
          <div class="hint">أضف خطًا من جهازك (TTF / OTF / WOFF / WOFF2).</div>
        </div>
        <button type="button" class="small" id="custom-font-add">إضافة خط</button>
      </div>
      <input
        id="custom-font-input"
        type="file"
        accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
        hidden
      />
      <div id="custom-font-list" class="custom-font-list">${customFontRows}</div>
      <div id="custom-font-status" class="hint" role="status"></div>
      ${persistenceError ? `<div class="notice" style="margin-top:8px">${escapeHtml(persistenceError)}</div>` : ""}
      <div class="hint" style="margin-top:8px">
        تُحفظ الخطوط داخل IndexedDB في هذا المتصفح فقط، ولا تُرفع إلى أي خادم.
        ملف PSD يخزّن اسم PostScript فقط؛ ثبّت الخط على جهاز فتح الملف لتعديل النص بنفس الشكل.
      </div>
    </div>

    <div class="field">
      <label class="row">
        <input data-setting="psdRtl" type="checkbox" ${s.psdRtl ? "checked" : ""} />
        تفعيل اتجاه RTL داخل طبقات PSD
      </label>
      <div class="hint">يفيد العربية في Photoshop. إذا ظهر النص معكوسًا، عطّله وأعد التركيب.</div>
    </div>

    <div class="field">
      <label class="row">
        <input data-setting="psdRasterPreview" type="checkbox" ${s.psdRasterPreview ? "checked" : ""} />
        إضافة طبقة معاينة نقطية للعربية (موصى به)
      </label>
      <div class="hint">
        تظهر النتيجة بدقة المتصفح فوق طبقات النص القابلة للتعديل. أخفِ طبقة Preview من لوحة الطبقات لتعديل النص الحي؛ طبقات النص ظاهرة ومزوّدة بصورة نقطية.
      </div>
    </div>

    <div class="field">
      <label class="row">
        <input data-setting="psdCompress" type="checkbox" ${s.psdCompress ? "checked" : ""} />
        ضغط PSD (ZIP) لتقليل الحجم
      </label>
    </div>

    <div class="notice">
      مفاتيح API تُحفظ في localStorage داخل هذا المتصفح فقط. لا تستخدم هذا البناء على استضافة عامة مع مفاتيحك.
    </div>
      </div>
    </details>
  `;
  void refreshCacheStatus();
}

async function refreshCacheStatus(): Promise<void> {
  const element = document.getElementById("translation-cache-count");
  if (!element) return;
  try {
    const count = await countTranslationCache();
    element.textContent = `${count} ترجمة محفوظة في هذا المتصفح`;
  } catch {
    element.textContent = "ذاكرة الترجمة غير متاحة في هذا المتصفح";
  }
}

function renderHelp(): void {
  const body = document.getElementById("help-body");
  if (!body) return;
  body.innerHTML = `
    <ol style="margin:0; padding-inline-start:18px; color:var(--muted); font-size:12px; line-height:1.9">
      <li>أضف صفحات المانجا: اختر عدة صور، أو اختر مجلدًا كاملًا، أو أفلت المجلد في منطقة الإضافة. تُرتّب الصفحات تلقائيًا حسب اسم الملف.</li>
      <li>اختر لغة المصدر ومحرك الترجمة من الإعدادات.</li>
      <li>اختر خط النص من الإعدادات، أو أضف خطك الخاص (TTF / OTF / WOFF / WOFF2).</li>
      <li>اضغط «ترجمة الكل» لتحليل كل الصفحات وترجمتها وتركيب PSD لها دفعة واحدة، أو «تحليل الكل» للتحليل والترجمة دون تركيب PSD.</li>
      <li>راجع النص الأصلي والترجمة في الجدول وعدّل ما تريد.</li>
      <li>استخدم «تحرير الصناديق» لإضافة صندوق فات من الكشف أو تصحيح موضع/حجم صندوق.</li>
      <li>بعد اكتمال التركيب، نزّل الصفحة الحالية أو استخدم «تنزيل كل PSD» لتنزيل جميع الصفحات في ملف ZIP.</li>
    </ol>
    <div class="divider"></div>
    <div class="notice info" style="margin-bottom:10px">
      <strong>مجلد كامل بضغطة واحدة:</strong> اضغط «اختيار مجلد» ثم «ترجمة الكل». سيعالج التطبيق
      الصفحات بالترتيب دون الحاجة لفتح كل صفحة وتشغيلها يدويًا.
    </div>
    <div class="notice info" style="margin-bottom:10px">
      <strong>الحفظ التلقائي:</strong> تُحفظ الصفحات والصناديق والترجمات في IndexedDB داخل هذا المتصفح.
      زر «حفظ الآن» يكتب فورًا، و«تصدير المشروع» ينشئ ملف <code>.mpsproj</code> يمكن استيراده لاحقًا.
      لا يضمّ ملف المشروع مفاتيح API ولا ملفات الخطوط المخصصة، ولا يحفظ ملفات PSD الناتجة.
    </div>
    <div class="notice info" style="margin-bottom:10px">
      ملف PSD يحتوي خلفية منظفة + طبقة نص قابلة للتعديل لكل فقاعة. عند تفعيل «طبقة المعاينة النقطية»
      تظهر نسخة عربية مطابقة للمتصفح فوق طبقات التعديل، وتبقى طبقات النص ظاهرة أسفلها ومزوّدة بصورة نقطية.
      أخفِ طبقة Preview من لوحة الطبقات لتعديل النص الحي.
      ملفات الخطوط لا تُضمّن داخل PSD؛ ثبّت الخط المختار على جهاز فتح الملف. الخطوط المخصصة
      محفوظة في هذا المتصفح ويمكنك تنزيل ملفها من قائمة «خطوط مخصصة» لتثبيته.
    </div>
    <div class="notice" style="margin-bottom:10px">
      إذا لم يظهر النص العربي بشكل صحيح داخل طبقة PSD، فعّل محرك النص الشرقي/World-Ready في Photoshop،
      أو عطّل خيار RTL وأعد التركيب. بعض برامج PSD لا تدعم تشكيل العربية داخل طبقات النص.
    </div>
    <div class="hint">
      الترخيص: كود هذا التطبيق AGPL-3.0-or-later لأنه يعيد استخدام وحدات من Libre Manga Translator.
      موديل Comic Text Detector بترخيص GPL-3.0، وRT-DETR/LaMa بتراخيص منفصلة. راجع README.
    </div>
  `;
}

function renderPages(): void {
  const grid = document.getElementById("pages-grid");
  const count = document.getElementById("page-count");
  if (count) count.textContent = String(state.pages.length);
  if (!grid) return;

  if (state.pages.length === 0) {
    updatePagesNavigation();
    grid.innerHTML = `<div class="empty">لم تُضف صفحات بعد. اسحب صور المانجا إلى الأعلى.</div>`;
    updateControls();
    return;
  }

  const job = selectedJob() ?? state.pages[0];
  const dotClass =
    job.status === "error"
      ? "err"
      : job.status === "analyzing" || job.status === "rendering"
        ? "busy"
        : job.status === "done"
          ? "ok"
          : "";
  const detail = job.error || job.stage || STATUS_LABEL[job.status];
  const busy = state.busy || job.status === "analyzing" || job.status === "rendering";

  // Render only the current page card. This keeps large folders lightweight:
  // the image thumbnails for the remaining pages are not inserted into the DOM.
  grid.innerHTML = `
    <div class="page-card active" data-page-id="${escapeHtml(job.id)}">
      <div class="page-thumb">
        <img src="${escapeHtml(job.url)}" alt="${escapeHtml(job.name)}" />
      </div>
      <div class="page-meta">
        <div class="page-name" title="${escapeHtml(job.name)}">${escapeHtml(job.name)}</div>
        <div class="page-status" title="${escapeHtml(detail)}">
          <span class="dot ${dotClass}"></span>
          <span>${escapeHtml(detail)}</span>
        </div>
        <div class="page-actions">
          <button class="small" data-action="analyze" ${busy ? "disabled" : ""}>
            ${job.analysis ? "إعادة تحليل" : "تحليل"}
          </button>
          <button class="small" data-action="render" ${busy ? "disabled" : ""}>تركيب</button>
          <button class="small primary" data-action="download" ${busy ? "disabled" : ""}>PSD</button>
          <button class="small danger" data-action="remove" ${state.busy ? "disabled" : ""}>حذف</button>
        </div>
      </div>
    </div>
  `;

  updatePagesNavigation();
  updateControls();
}

function updatePagesNavigation(): void {
  const previous = document.getElementById("pages-previous-page") as HTMLButtonElement | null;
  const next = document.getElementById("pages-next-page") as HTMLButtonElement | null;
  const position = document.getElementById("pages-page-position");
  const index = state.pages.findIndex((page) => page.id === state.selectedId);
  const hasSelection = index >= 0;

  if (position) {
    position.textContent = hasSelection ? `${index + 1} / ${state.pages.length}` : "—";
  }
  if (previous) previous.disabled = !hasSelection || index === 0;
  if (next) next.disabled = !hasSelection || index === state.pages.length - 1;
}

function renderPreview(): void {
  const stage = document.getElementById("preview-stage");
  const side = document.getElementById("preview-side");
  const tabs = document.querySelectorAll<HTMLButtonElement>("[data-tab]");
  if (!stage || !side) return;

  const job = selectedJob();
  updatePreviewNavigation();
  if (!job) {
    state.boxEditMode = false;
    state.selectedBoxIndex = null;
    stage.innerHTML = `<div class="empty">اختر صفحة لعرض المعاينة.</div>`;
    side.innerHTML = "";
    tabs.forEach((tab) => {
      tab.disabled = tab.dataset.tab !== "original";
    });
    return;
  }

  if (!job.analysis) {
    state.boxEditMode = false;
    state.selectedBoxIndex = null;
  }
  if (
    state.selectedBoxIndex !== null &&
    (!job.analysis || state.selectedBoxIndex >= job.analysis.boxes.length)
  ) {
    state.selectedBoxIndex = null;
  }

  const hasRender = Boolean(job.render);
  let tab = state.previewTab;
  if ((tab === "cleaned" || tab === "final") && !hasRender) tab = "original";
  if (state.boxEditMode) tab = "original";
  state.previewTab = tab;

  tabs.forEach((button) => {
    const value = button.dataset.tab as PreviewTab;
    button.classList.toggle("active", value === tab);
    button.disabled =
      (value !== "original" && !hasRender) || (state.boxEditMode && value !== "original");
  });

  const src =
    tab === "final"
      ? job.render?.finalUrl
      : tab === "cleaned"
        ? job.render?.cleanedUrl
        : job.url;
  const editingBoxes = state.boxEditMode && tab === "original" && Boolean(job.analysis);

  if (!src) {
    stage.innerHTML = `<div class="empty">لا توجد صورة معاينة لهذه الحالة بعد.</div>`;
  } else if (editingBoxes) {
    stage.innerHTML = `
      <div class="box-editor" id="box-editor">
        <img src="${escapeHtml(src)}" alt="معاينة ${escapeHtml(job.name)}" draggable="false" />
        <div class="box-overlay" id="box-overlay" aria-label="محرر صناديق النص">
          ${boxOverlayMarkup(job)}
        </div>
      </div>
    `;
  } else {
    stage.innerHTML = `<img src="${escapeHtml(src)}" alt="معاينة ${escapeHtml(job.name)}" />`;
  }

  const translated = job.analysis
    ? job.analysis.translations.filter((text) => text.trim()).length
    : 0;
  const boxCount = job.analysis?.boxes.length ?? 0;
  const psdSize = job.render ? formatBytes(job.render.psd.byteLength) : "—";
  const selectedBox =
    job.analysis && state.selectedBoxIndex !== null
      ? job.analysis.boxes[state.selectedBoxIndex] ?? null
      : null;
  const selectionText = selectedBox
    ? `#${(state.selectedBoxIndex ?? 0) + 1} · ${Math.round(
        selectedBox.x2 - selectedBox.x1,
      )} × ${Math.round(selectedBox.y2 - selectedBox.y1)} px`
    : "لم تحدد صندوقًا";

  side.innerHTML = `
    <div class="stat"><b>الملف</b><span>${escapeHtml(job.name)}</span></div>
    <div class="stat"><b>الأبعاد</b><span>${job.width || "?"} × ${job.height || "?"}</span></div>
    <div class="stat"><b>مناطق النص</b><span>${boxCount}</span></div>
    <div class="stat"><b>ترجمات غير فارغة</b><span>${translated}</span></div>
    <div class="stat"><b>حجم PSD</b><span>${psdSize}</span></div>
    ${
      job.dirty
        ? `<div class="notice">${
            job.render
              ? "تم تعديل الترجمة بعد آخر تركيب. اضغط «تركيب وتحديث PSD» لتطبيق التعديلات."
              : "لم يُنشأ PSD بعد أو تم استئناف المشروع. اضغط «تركيب وتحديث PSD» لإنشاء الملف."
          }</div>`
        : ""
    }
    ${job.error ? `<div class="notice err">${escapeHtml(job.error)}</div>` : ""}
    <button
      class="${state.boxEditMode ? "primary" : ""}"
      data-preview-action="edit-boxes"
      ${state.busy || !job.analysis ? "disabled" : ""}
    >${state.boxEditMode ? "إنهاء تحرير الصناديق" : "تحرير الصناديق"}</button>
    ${
      state.boxEditMode
        ? `
          <div class="box-editor-panel">
            <div class="notice info">
              اسحب على الصورة لرسم صندوق جديد. اسحب الصندوق لتحريكه، واسحب المقابض لتغيير الحجم.
              اضغط Delete لحذف المحدد، والأسهم لتحريكه بدقة.
            </div>
            <div class="box-selection-label" id="box-selection-label">${escapeHtml(selectionText)}</div>
            <div class="box-editor-actions">
              <button
                class="small danger"
                data-box-action="delete"
                ${state.busy || state.selectedBoxIndex === null ? "disabled" : ""}
              >حذف المحدد</button>
              <button
                class="small"
                data-box-action="translate"
                ${state.busy || state.settings.engine === "manual" || boxCount === 0 ? "disabled" : ""}
              >ترجمة المناطق</button>
            </div>
            ${
              state.settings.engine === "manual"
                ? `<div class="hint">الوضع اليدوي: اكتب الترجمة العربية في جدول النصوص.</div>`
                : ""
            }
          </div>
        `
        : ""
    }
    <button class="primary" data-preview-action="psd" ${state.busy ? "disabled" : ""}>تنزيل PSD</button>
    <button data-preview-action="png" ${state.busy ? "disabled" : ""}>تنزيل PNG</button>
    <button data-preview-action="render" ${state.busy ? "disabled" : ""}>إعادة التركيب</button>
  `;
  updateBoxEditorSelectionUi();
}

function updatePreviewNavigation(): void {
  const previous = document.getElementById("preview-previous-page") as HTMLButtonElement | null;
  const next = document.getElementById("preview-next-page") as HTMLButtonElement | null;
  const position = document.getElementById("preview-page-position");
  const index = state.pages.findIndex((page) => page.id === state.selectedId);
  const hasSelection = index >= 0;

  if (position) {
    position.textContent = hasSelection ? `${index + 1} / ${state.pages.length}` : "—";
  }
  if (previous) previous.disabled = !hasSelection || index === 0;
  if (next) next.disabled = !hasSelection || index === state.pages.length - 1;
}

function boxPositionStyle(box: Bbox, width: number, height: number): string {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const left = clamp(box.x1, 0, safeWidth);
  const top = clamp(box.y1, 0, safeHeight);
  const right = clamp(box.x2, left + 1, safeWidth);
  const bottom = clamp(box.y2, top + 1, safeHeight);
  return [
    `left:${(left / safeWidth) * 100}%`,
    `top:${(top / safeHeight) * 100}%`,
    `width:${((right - left) / safeWidth) * 100}%`,
    `height:${((bottom - top) / safeHeight) * 100}%`,
  ].join(";");
}

function boxOverlayMarkup(job: PageJob): string {
  const analysis = job.analysis;
  if (!analysis) return "";
  const width = job.width || 1;
  const height = job.height || 1;
  return analysis.boxes
    .map((box, index) => {
      const selected = state.selectedBoxIndex === index;
      const translation = analysis.translations[index]?.trim() || `منطقة ${index + 1}`;
      const label = `#${index + 1}${box.manual ? " · يدوي" : ""}`;
      const handles = BOX_HANDLES.map(
        (handle) =>
          `<span class="box-handle ${handle}" data-handle="${handle}" aria-hidden="true"></span>`,
      ).join("");
      return `
        <div
          class="box-item${selected ? " selected" : ""}${box.manual ? " manual" : ""}"
          data-box-index="${index}"
          style="${boxPositionStyle(box, width, height)}"
          title="${escapeHtml(translation)}"
        >
          <span class="box-label">${escapeHtml(label)}</span>
          ${handles}
        </div>
      `;
    })
    .join("");
}

function updateBoxEditorSelectionUi(): void {
  const selected = state.selectedBoxIndex;
  document.querySelectorAll<HTMLElement>("[data-box-index]").forEach((element) => {
    const index = Number(element.dataset.boxIndex);
    element.classList.toggle("selected", index === selected);
  });
  const label = document.getElementById("box-selection-label");
  const job = selectedJob();
  if (label && job?.analysis && selected !== null) {
    const box = job.analysis.boxes[selected];
    if (box) {
      label.textContent = `#${selected + 1} · ${Math.round(box.x2 - box.x1)} × ${Math.round(
        box.y2 - box.y1,
      )} px`;
    }
  } else if (label) {
    label.textContent = "لم تحدد صندوقًا";
  }
  const deleteButton = document.querySelector<HTMLButtonElement>('[data-box-action="delete"]');
  if (deleteButton) deleteButton.disabled = state.busy || selected === null;
}

function setSelectedBox(index: number | null): void {
  state.selectedBoxIndex = index;
  updateBoxEditorSelectionUi();
}

function renderTranslations(): void {
  const body = document.getElementById("translations-body");
  const count = document.getElementById("translation-count");
  if (!body) return;

  const job = selectedJob();
  if (!job) {
    if (count) count.textContent = "0";
    body.innerHTML = `<div class="empty">اختر صفحة لعرض النصوص.</div>`;
    updateControls();
    return;
  }

  if (!job.analysis) {
    if (count) count.textContent = "0";
    body.innerHTML = `<div class="empty">لم يتم تحليل هذه الصفحة بعد. اضغط «تحليل» على الصفحة أو «تحليل الكل».</div>`;
    updateControls();
    return;
  }

  const { boxes, translations, sourceTexts } = job.analysis;
  if (count) count.textContent = String(boxes.length);

  if (boxes.length === 0) {
    body.innerHTML = `<div class="empty">لم يتم العثور على مناطق نص في هذه الصفحة. جرّب تقليل حد الثقة أو موديل كشف آخر.</div>`;
    updateControls();
    return;
  }

  const rows = boxes
    .map((box, index) => {
      const source = sourceTexts[index] ?? "";
      const translation = translations[index] ?? "";
      const selected = state.selectedBoxIndex === index;
      return `
        <tr data-box-index="${index}" class="${selected ? "selected" : ""}">
          <td>${index + 1}</td>
          <td>
            <textarea class="source-input" data-source-index="${index}" spellcheck="false"
              placeholder="النص الأصلي…">${escapeHtml(source)}</textarea>
            <div class="hint" style="margin-top:4px">
              ثقة ${box.confidence.toFixed(2)}${box.manual ? " · صندوق يدوي" : ""}
            </div>
          </td>
          <td>
            <textarea data-index="${index}" spellcheck="false"
              placeholder="اكتب الترجمة العربية…">${escapeHtml(translation)}</textarea>
          </td>
        </tr>
      `;
    })
    .join("");

  body.innerHTML = `
    ${
      state.settings.engine === "manual"
        ? `<div class="notice info" style="margin-bottom:10px">الوضع اليدوي: اكتب الترجمة العربية لكل منطقة، ثم اضغط «تركيب وتحديث PSD».</div>`
        : ""
    }
    ${
      state.boxEditMode
        ? `<div class="notice info" style="margin-bottom:10px">وضع تحرير الصناديق مفعّل: اختر صندوقًا من الصورة أو من الصفوف، ثم عدّل موضعه أو حجمه. الترجمة الأصلية قابلة للتعديل أيضًا.</div>`
        : ""
    }
    <div class="table-wrap">
      <table class="translations">
        <thead>
          <tr>
            <th>#</th>
            <th>النص الأصلي (قابل للتعديل)</th>
            <th>الترجمة العربية (قابلة للتعديل)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
  updateControls();
}

function renderStatus(): void {
  const text = document.getElementById("status-text");
  const progressText = document.getElementById("progress-text");
  const bar = document.getElementById("progress-bar");
  if (text) text.textContent = state.status;
  const percent = Math.max(0, Math.min(100, Math.round(state.progress)));
  if (progressText) progressText.textContent = `${percent}%`;
  if (bar) bar.style.width = `${percent}%`;
  updateControls();
  renderBatchMetrics();
}

function formatSavedTime(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat("ar", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(timestamp);
  } catch {
    return new Date(timestamp).toLocaleTimeString();
  }
}

function renderProjectState(): void {
  const element = document.getElementById("project-state");
  if (!element) return;
  element.classList.toggle("err", Boolean(state.projectError));
  element.title = state.projectError;
  if (state.projectSaving) {
    element.textContent = "جاري حفظ المشروع…";
  } else if (state.projectError) {
    element.textContent = "تعذّر الوصول إلى المشروع";
  } else if (state.projectSavedAt) {
    element.textContent = `محفوظ محليًا ${formatSavedTime(state.projectSavedAt)}`;
  } else {
    element.textContent = "الحفظ التلقائي مفعّل";
  }
}

function updateControls(): void {
  const hasPages = state.pages.length > 0;
  const job = selectedJob();
  const setDisabled = (id: string, disabled: boolean) => {
    const element = document.getElementById(id) as HTMLButtonElement | null;
    if (element) element.disabled = disabled;
  };

  setDisabled("analyze-all", state.busy || !hasPages);
  setDisabled("process-all", state.busy || !hasPages);
  setDisabled("download-all", state.busy || !hasPages);
  const stop = document.getElementById("stop-batch") as HTMLButtonElement | null;
  if (stop) {
    stop.hidden = !state.batchAbort;
    stop.disabled = !state.batchAbort;
  }
  setDisabled("clear-all", state.busy || !hasPages);
  setDisabled("pick-files", state.busy);
  setDisabled("pick-folder", state.busy);
  setDisabled("add-folder", state.busy);
  setDisabled("add-more", state.busy);
  setDisabled("reanalyze-selected", state.busy || !job);
  setDisabled(
    "retranslate-selected",
    state.busy ||
      !job?.analysis ||
      job.analysis.boxes.length === 0 ||
      state.settings.engine === "manual",
  );
  setDisabled("render-selected", state.busy || !job || !job.analysis);
  setDisabled("download-selected", state.busy || !job);
  setDisabled("save-project", state.busy);
  setDisabled("export-project", state.busy || !hasPages);
  setDisabled("import-project", state.busy);
  setDisabled("toggle-box-editor", state.busy || !job?.analysis);

  const toggle = document.getElementById("toggle-box-editor");
  if (toggle) {
    toggle.textContent = state.boxEditMode ? "إنهاء تحرير الصناديق" : "تحرير الصناديق";
    toggle.classList.toggle("primary", state.boxEditMode);
    toggle.setAttribute("aria-pressed", String(state.boxEditMode));
  }

  const processButton = document.getElementById("process-all");
  if (processButton) {
    const manual = state.settings.engine === "manual";
    processButton.textContent = manual ? "تركيب الكل" : "ترجمة الكل";
    processButton.title = manual
      ? "تحليل الصفحات وتركيب PSD للصفحات التي تحتوي ترجمات"
      : "تحليل كل الصفحات وترجمتها وتركيب PSD لها دفعة واحدة";
  }
  const analyzeButton = document.getElementById("analyze-all");
  if (analyzeButton) {
    analyzeButton.title =
      state.settings.engine === "manual"
        ? "كشف مناطق النص فقط في كل الصفحات دون تركيب PSD"
        : "تحليل وترجمة كل الصفحات دون تركيب PSD";
  }

  updateBoxEditorSelectionUi();
}

function batchProgress(localPercent: number): number {
  if (state.batchTotal <= 0) return localPercent;
  const clamped = clamp(localPercent, 0, 100);
  const phaseStart =
    state.batchPhase === "analyze" ? 0 : state.batchPhase === "translate" ? 30 : 70;
  const phaseSpan = state.batchPhase === "analyze" ? 30 : state.batchPhase === "translate" ? 40 : 30;
  const pageFraction = (phaseStart + (clamped / 100) * phaseSpan) / 100;
  return ((state.batchIndex + pageFraction) / state.batchTotal) * 100;
}

function setProgressPercent(localPercent: number): void {
  state.progress = batchProgress(localPercent);
}

function setProgress(stage: PipelineStage, message?: string): void {
  setProgressPercent(STAGE_PROGRESS[stage] ?? 0);
  if (message) state.status = message;
  renderStatus();
}

function refreshAll(): void {
  renderPages();
  renderPreview();
  renderTranslations();
  renderStatus();
  renderProjectState();
}

function refreshProgress(): void {
  renderPages();
  renderPreview();
  renderStatus();
}

function createRequestManager(): RequestManager {
  return new RequestManager({
    config: {
      maxConcurrent: state.settings.maxConcurrentRequests,
      rpm: state.settings.rpmLimit,
      tpm: state.settings.tpmLimit,
      maxRetries: state.settings.maxRetries,
    },
  });
}

function trackManager(manager: RequestManager): () => void {
  return manager.subscribe((stats) => {
    state.apiStats = stats;
    state.batchStats.requests = stats.requests;
    state.batchStats.promptTokens = stats.promptTokens;
    state.batchStats.candidatesTokens = stats.candidatesTokens;
    state.batchStats.totalTokens = stats.totalTokens;
    if (stats.quotaPausedUntil) {
      state.apiNote = stats.quotaReason || "توقفت الطلبات مؤقتًا بسبب استنفاد الحصة.";
    } else if (!stats.lastError) {
      state.apiNote = "";
    }
    renderBatchMetrics();
  });
}

function formatNumber(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("ar-EG");
}

function renderBatchMetrics(): void {
  const element = document.getElementById("batch-metrics");
  if (!element) return;
  const stats = state.batchStats;
  const visible =
    state.busy ||
    stats.pagesTotal > 0 ||
    stats.requests > 0 ||
    stats.errors > 0 ||
    stats.cacheHits > 0;
  element.hidden = !visible;
  if (!visible) {
    element.innerHTML = "";
    return;
  }
  const cells = [
    ["الصفحات المحللة", `${formatNumber(stats.pagesAnalyzed)} / ${formatNumber(stats.pagesTotal)}`],
    ["فقرات OCR", formatNumber(stats.extractedBubbles)],
    ["الترجمات", `${formatNumber(stats.translatedBubbles)} / ${formatNumber(stats.totalBubbles)}`],
    ["طلبات Gemini", formatNumber(stats.requests)],
    ["توكنات فعلية", formatNumber(stats.totalTokens)],
    ["إصابات الذاكرة", formatNumber(stats.cacheHits)],
    ["دفعات متبقية", formatNumber(stats.remainingBatches)],
    ["أخطاء", formatNumber(stats.errors)],
  ];
  if (stats.ocrFailures > 0) cells.push(["فشل OCR", formatNumber(stats.ocrFailures)]);
  if (stats.visionFallbacks > 0) {
    cells.push(["Vision بديل", formatNumber(stats.visionFallbacks)]);
  }
  if (stats.missingBubbles > 0) {
    cells.push(["فقرات ناقصة", formatNumber(stats.missingBubbles)]);
  }
  element.innerHTML = `
    <div class="batch-metrics-grid">
      ${cells
        .map(
          ([label, value]) =>
            `<div class="batch-metric"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`,
        )
        .join("")}
    </div>
    ${
      state.apiNote
        ? `<div class="notice err batch-metric-note">${escapeHtml(state.apiNote)}</div>`
        : ""
    }
  `;
}

async function doAnalyze(job: PageJob): Promise<void> {
  const settingsError = validateSettings(state.settings);
  if (settingsError) throw new Error(settingsError);

  state.batchPhase = "analyze";
  if (state.batchTotal <= 1) {
    state.batchStats = emptyBatchStats(1);
    state.batchTotal = 1;
    state.batchIndex = 0;
  }
  job.status = "analyzing";
  job.error = "";
  job.stage = "تهيئة الكشف…";
  job.render = null;
  job.dirty = false;
  state.boxEditMode = false;
  state.selectedBoxIndex = null;
  setProgressPercent(0);
  state.status = `تحليل ${job.name}…`;
  refreshAll();

  try {
    const analysis = await analyzePage(job.url, toPipelineSettings(state.settings), (stage, message) => {
      job.stage = message || stage;
      setProgress(stage, message);
      refreshProgress();
    });
    job.analysis = analysis;
    job.status = "ready";
    const ocrTextCount = analysis.sourceTexts.filter((text) => text.trim()).length;
    const failed = analysis.ocrFailedBoxes?.length ?? 0;
    job.stage =
      analysis.boxes.length > 0
        ? `${analysis.boxes.length} منطقة · ${ocrTextCount} نص · ${failed} فشل OCR`
        : "لم يتم العثور على نص";
    setProgressPercent(100);
    state.status =
      analysis.boxes.length > 0
        ? `تم تحليل ${job.name}: ${analysis.boxes.length} منطقة، و${ocrTextCount} فقرة مقروءة محليًا.`
        : `لم يتم العثور على نص في ${job.name}.`;
    if (state.batchTotal <= 1) {
      state.batchStats.pagesAnalyzed = 1;
      state.batchStats.extractedBubbles = ocrTextCount;
      state.batchStats.totalBubbles =
        state.settings.engine === "gemini" && state.settings.geminiMode === "text"
        ? ocrTextCount
        : analysis.boxes.length;
      state.batchStats.translatedBubbles = analysis.translations.filter((text) =>
        text.trim(),
      ).length;
      state.batchStats.ocrFailures = failed;
      state.batchStats.batchesTotal = 0;
      state.batchStats.batchesDone = 0;
      state.batchStats.remainingBatches = 0;
      renderBatchMetrics();
    }
    if (analysis.ocrError) {
      toast(
        `OCR المحلي غير متاح: ${analysis.ocrError}. يمكنك تفعيل Vision كبديل من الإعدادات.`,
        "err",
        9000,
      );
    } else if (analysis.boxes.length === 0) {
      toast("لم يتم العثور على مناطق نص. جرّب تقليل حد الثقة.", "err", 6000);
    }
  } catch (err) {
    job.status = "error";
    job.error = errorMessage(err);
    job.stage = "";
    setProgressPercent(0);
    state.status = `فشل تحليل ${job.name}.`;
    throw err;
  } finally {
    refreshAll();
    scheduleProjectSave();
  }
}

async function doRender(job: PageJob): Promise<void> {
  if (!job.analysis) {
    await doAnalyze(job);
  }
  if (!job.analysis) throw new Error("لا توجد نتائج تحليل لهذه الصفحة.");

  state.batchPhase = "render";
  job.status = "rendering";
  job.error = "";
  job.stage = "تنظيف الصفحة…";
  state.boxEditMode = false;
  state.selectedBoxIndex = null;
  setProgressPercent(0);
  state.status = `تركيب ${job.name}…`;
  refreshAll();

  try {
    const render = await renderPage(
      job.url,
      job.analysis,
      toPipelineSettings(state.settings),
      (stage, message) => {
        job.stage = message || stage;
        setProgress(stage, message);
        refreshProgress();
      },
    );
    job.render = render;
    job.dirty = false;
    job.status = "done";
    job.stage = "PSD جاهز";
    state.previewTab = "final";
    setProgressPercent(100);
    state.status = `تم إنشاء PSD لـ ${job.name}.`;
  } catch (err) {
    job.status = "error";
    job.error = errorMessage(err);
    job.stage = "";
    setProgressPercent(0);
    state.status = `فشل تركيب ${job.name}.`;
    throw err;
  } finally {
    refreshAll();
    scheduleProjectSave();
  }
}

async function ensureAnalysis(job: PageJob): Promise<void> {
  if (!job.analysis) await doAnalyze(job);
}

async function ensureRender(job: PageJob): Promise<void> {
  await ensureAnalysis(job);
  if (state.settings.engine !== "manual") await ensureTranslations(job);
  if (!job.render || job.dirty) await doRender(job);
}

function pageHasTranslations(job: PageJob): boolean {
  return Boolean(job.analysis?.translations.some((text) => text.trim()));
}

interface TranslateJobOptions {
  manager?: RequestManager;
  signal?: AbortSignal;
  force?: boolean;
}

async function translateVisionFallback(
  job: PageJob,
  manager: RequestManager,
  signal: AbortSignal | undefined,
  settings: TranslationSettings,
): Promise<number> {
  const analysis = job.analysis;
  if (!analysis || analysis.boxes.length === 0) return 0;
  const failed = new Set(analysis.ocrFailedBoxes ?? []);
  const indexes = [...failed].filter(
    (index) =>
      index >= 0 &&
      index < analysis.boxes.length &&
      !analysis.translations[index]?.trim(),
  );
  if (indexes.length === 0) return 0;

  const boxes = indexes.map((index) => analysis.boxes[index]);
  const visionSettings: TranslationSettings = { ...settings, geminiMode: "vision" };
  const result = await translatePage(job.url, boxes, visionSettings, {
    manager,
    signal,
  });
  let translated = 0;
  indexes.forEach((boxIndex, localIndex) => {
    const translation = result.translations[localIndex] ?? "";
    if (translation.trim()) {
      analysis.translations[boxIndex] = translation;
      const source = result.sourceTexts?.[localIndex] ?? "";
      if (source.trim()) analysis.sourceTexts[boxIndex] = source;
      failed.delete(boxIndex);
      translated++;
    }
  });
  analysis.ocrFailedBoxes = failed.size > 0 ? [...failed] : undefined;
  if (translated > 0) {
    state.batchStats.visionFallbacks += translated;
    job.dirty = true;
    if (job.status === "done") job.status = "ready";
  }
  return translated;
}

async function translateJob(job: PageJob, options: TranslateJobOptions = {}): Promise<void> {
  if (!job.analysis) throw new Error("حلل الصفحة أولًا قبل ترجمة المناطق.");
  if (state.settings.engine === "manual") {
    throw new Error("الوضع اليدوي لا يستدعي مزود ترجمة.");
  }
  if (job.analysis.boxes.length === 0) return;

  const standalone = !options.manager;
  const manager = options.manager ?? createRequestManager();
  const unsubscribe = standalone ? trackManager(manager) : () => {};
  const settings = toPipelineSettings(state.settings).translation;
  const analysis = job.analysis;
  const force = options.force === true;
  const translationMode = isTextOnlyTranslation(settings);
  const targets = analysis.boxes
    .map((_, index) => index)
    .filter((index) => {
      if (!force && analysis.translations[index]?.trim()) return false;
      if (translationMode && !analysis.sourceTexts[index]?.trim()) return false;
      return true;
    });

  if (targets.length === 0 && !(settings.useVisionOnOcrFailure && analysis.ocrFailedBoxes?.length)) {
    return;
  }

  if (standalone) {
    state.batchTotal = Math.max(1, targets.length);
    state.batchIndex = 0;
    state.batchPhase = "translate";
    state.batchStats = emptyBatchStats(1);
    state.batchStats.pagesAnalyzed = 1;
  }

  try {
    if (translationMode) {
      const inputs: TranslationBubbleInput[] = targets
        .filter((index) => analysis.sourceTexts[index]?.trim())
        .map((index) => ({
          id: buildBubbleId(state.pages.indexOf(job), index),
          text: analysis.sourceTexts[index],
          pageId: job.id,
          pageIndex: Math.max(0, state.pages.indexOf(job)),
          boxIndex: index,
        }));
      const planned = planTextBatches(inputs, {
        smartBatch: settings.smartBatch,
        batchPages: settings.batchPages,
        tokenBudget: settings.batchTokenBudget,
        maxSegmentsPerBatch: 120,
      });
      state.batchStats.totalBubbles = Math.max(
        state.batchStats.totalBubbles,
        analysis.sourceTexts.filter((text) => text.trim()).length,
      );
      state.batchStats.extractedBubbles = Math.max(
        state.batchStats.extractedBubbles,
        state.batchStats.totalBubbles,
      );
      state.batchStats.batchesTotal = planned.length;
      state.batchStats.remainingBatches = planned.length;
      if (standalone && planned.length > 0) {
        state.batchTotal = planned.length;
        state.batchIndex = 0;
      }
      if (inputs.length > 0) {
        const result = await translateBubbles(inputs, {
          settings,
          manager,
          signal: options.signal,
          forceRefresh: force,
          callbacks: {
            onTranslated: (input, translation) => {
              const targetJob = state.pages.find((page) => page.id === input.pageId);
              if (!targetJob?.analysis) return;
              targetJob.analysis.translations[input.boxIndex] = translation;
              targetJob.dirty = true;
              if (targetJob.status === "done") targetJob.status = "ready";
              state.batchStats.translatedBubbles++;
              renderBatchMetrics();
            },
            onCacheHit: () => {
              state.batchStats.cacheHits++;
            },
            onBatchStart: (batch, index, total) => {
              state.batchIndex = standalone ? index : state.batchIndex;
              state.batchStats.remainingBatches = Math.max(0, total - index);
              state.status = `ترجمة ${batch.segments.length} فقرة (${index + 1}/${total})…`;
              setProgressPercent(0);
              refreshProgress();
            },
            onBatchComplete: (_batch, _index, total, _translated, error) => {
              state.batchStats.batchesDone++;
              state.batchStats.remainingBatches = Math.max(0, total - state.batchStats.batchesDone);
              if (error) state.batchStats.errors++;
              if (standalone) {
                state.batchIndex = state.batchStats.batchesDone;
                setProgressPercent(100);
              }
              renderBatchMetrics();
              void scheduleProjectSave();
            },
            onError: () => {
              state.batchStats.errors++;
            },
          },
        });
        state.batchStats.missingBubbles = result.missing.length;
        state.batchStats.batchesTotal = result.batches;
        state.batchStats.remainingBatches = Math.max(
          0,
          result.batches - state.batchStats.batchesDone,
        );
        state.status =
          result.missing.length > 0
            ? `ترجمت ${result.translations.size} فقرة، وبقيت ${result.missing.length} فقرة تحتاج إعادة محاولة.`
            : `تمت ترجمة ${result.translations.size} فقرة.`;
      }
    } else {
      const boxes = targets.map((index) => analysis.boxes[index]);
      if (boxes.length > 0) {
        const result = await translatePage(job.url, boxes, settings, {
          manager,
          signal: options.signal,
        });
        targets.forEach((boxIndex, localIndex) => {
          analysis.translations[boxIndex] = result.translations[localIndex] ?? "";
          const source = result.sourceTexts?.[localIndex] ?? "";
          if (source.trim()) analysis.sourceTexts[boxIndex] = source;
        });
        if (standalone) {
          state.batchStats.translatedBubbles += targets.filter(
            (index) => analysis.translations[index]?.trim(),
          ).length;
        }
      }
    }

    if (settings.useVisionOnOcrFailure && analysis.ocrFailedBoxes?.length) {
      const fallback = await translateVisionFallback(
        job,
        manager,
        options.signal,
        settings,
      );
      if (fallback > 0) {
        state.status = `تمت ترجمة ${fallback} فقرة عبر Vision بعد فشل OCR.`;
      }
    }

    job.dirty = true;
    if (job.status === "done") job.status = "ready";
    job.stage = `${analysis.translations.filter((text) => text.trim()).length} ترجمة`;
    if (standalone) {
      state.batchIndex = Math.max(0, state.batchTotal);
      setProgressPercent(100);
    }
    scheduleProjectSave();
  } catch (error) {
    job.stage = "فشلت ترجمة المناطق";
    throw error;
  } finally {
    unsubscribe();
    if (standalone) refreshAll();
  }
}

async function ensureTranslations(job: PageJob): Promise<void> {
  if (state.settings.engine === "manual") return;
  if (!job.analysis || job.analysis.boxes.length === 0) return;
  await translateJob(job);
}

async function analyzeAndTranslateJob(job: PageJob): Promise<void> {
  state.batchStats = emptyBatchStats(1);
  state.batchTotal = 1;
  state.batchIndex = 0;
  state.batchPhase = "analyze";
  await doAnalyze(job);
  if (state.settings.engine === "manual") {
    state.batchStats.pagesAnalyzed = 1;
    state.batchStats.extractedBubbles = job.analysis?.sourceTexts.filter((text) => text.trim()).length ?? 0;
    renderBatchMetrics();
    return;
  }
  await translateJob(job, { force: true });
  state.batchStats.pagesAnalyzed = 1;
  renderBatchMetrics();
}

async function retranslateSelected(): Promise<void> {
  const job = selectedJob();
  if (!job?.analysis) {
    toast("حلل الصفحة أولًا قبل ترجمة المناطق.", "err");
    return;
  }
  if (state.settings.engine === "manual") {
    toast("الوضع اليدوي لا يستدعي مزود ترجمة. اكتب النص في الجدول.", "err");
    return;
  }
  if (job.analysis.boxes.length === 0) {
    toast("لا توجد مناطق نص لترجمتها.", "err");
    return;
  }
  if (
    pageHasTranslations(job) &&
    !window.confirm(
      "ستُستبدل الترجمات الحالية لكل المناطق، بما فيها التعديلات اليدوية. هل تريد المتابعة؟",
    )
  ) {
    return;
  }

  await runTask(`ترجمة مناطق ${job.name}…`, async () => {
    try {
      await translateJob(job, { force: true });
      state.progress = 100;
    } finally {
      refreshAll();
    }
  });
}

function toggleBoxEditor(force?: boolean): void {
  if (state.busy) return;
  const job = selectedJob();
  if (!job?.analysis) {
    toast("حلل الصفحة أولًا لتحرير الصناديق.", "err");
    return;
  }
  const next = force ?? !state.boxEditMode;
  if (next) {
    state.previewTab = "original";
    if (
      state.selectedBoxIndex !== null &&
      state.selectedBoxIndex >= job.analysis.boxes.length
    ) {
      state.selectedBoxIndex = null;
    }
  }
  state.boxEditMode = next;
  refreshAll();
}

function markBoxDirty(job: PageJob): void {
  job.dirty = true;
  if (job.status === "done") job.status = "ready";
}

function pageSizeFor(job: PageJob): { width: number; height: number } {
  return {
    width: Math.max(1, job.width || 1),
    height: Math.max(1, job.height || 1),
  };
}

function pointFromEvent(
  event: PointerEvent,
  overlay: HTMLElement,
  pageWidth: number,
  pageHeight: number,
): { x: number; y: number } {
  const rect = overlay.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return {
    x: clamp(((event.clientX - rect.left) / rect.width) * pageWidth, 0, pageWidth),
    y: clamp(((event.clientY - rect.top) / rect.height) * pageHeight, 0, pageHeight),
  };
}

function boxFromPoints(x1: number, y1: number, x2: number, y2: number): Bbox {
  return {
    x1: Math.min(x1, x2),
    y1: Math.min(y1, y2),
    x2: Math.max(x1, x2),
    y2: Math.max(y1, y2),
    confidence: 1,
    manual: true,
  };
}

function applyBoxElementStyle(
  element: HTMLElement,
  box: Bbox,
  pageWidth: number,
  pageHeight: number,
): void {
  const style = boxPositionStyle(box, pageWidth, pageHeight);
  for (const declaration of style.split(";")) {
    const [property, value] = declaration.split(":");
    if (!property || !value) continue;
    element.style.setProperty(property.trim(), value.trim());
  }
}

function moveBoxBy(
  box: Bbox,
  dx: number,
  dy: number,
  pageWidth: number,
  pageHeight: number,
): Bbox {
  const width = box.x2 - box.x1;
  const height = box.y2 - box.y1;
  const x1 = clamp(box.x1 + dx, 0, Math.max(0, pageWidth - width));
  const y1 = clamp(box.y1 + dy, 0, Math.max(0, pageHeight - height));
  return { ...box, x1, y1, x2: x1 + width, y2: y1 + height };
}

function resizeBoxBy(
  box: Bbox,
  handle: BoxHandle,
  dx: number,
  dy: number,
  pageWidth: number,
  pageHeight: number,
): Bbox {
  let { x1, y1, x2, y2 } = box;
  const minWidth = Math.min(BOX_MIN_SIZE, pageWidth);
  const minHeight = Math.min(BOX_MIN_SIZE, pageHeight);
  if (handle.includes("w")) x1 = clamp(box.x1 + dx, 0, box.x2 - minWidth);
  if (handle.includes("e")) x2 = clamp(box.x2 + dx, box.x1 + minWidth, pageWidth);
  if (handle.includes("n")) y1 = clamp(box.y1 + dy, 0, box.y2 - minHeight);
  if (handle.includes("s")) y2 = clamp(box.y2 + dy, box.y1 + minHeight, pageHeight);
  return { ...box, x1, y1, x2, y2 };
}

function addManualBox(job: PageJob, box: Bbox): void {
  if (!job.analysis) return;
  const width = Math.max(1, job.width || 1);
  const height = Math.max(1, job.height || 1);
  const manualBox: Bbox = {
    x1: clamp(box.x1, 0, width),
    y1: clamp(box.y1, 0, height),
    x2: clamp(box.x2, 0, width),
    y2: clamp(box.y2, 0, height),
    confidence: 1,
    manual: true,
  };
  if (
    manualBox.x2 - manualBox.x1 < BOX_MIN_SIZE ||
    manualBox.y2 - manualBox.y1 < BOX_MIN_SIZE
  ) {
    return;
  }
  job.analysis.boxes.push(manualBox);
  job.analysis.translations.push("");
  job.analysis.sourceTexts.push("");
  state.selectedBoxIndex = job.analysis.boxes.length - 1;
  markBoxDirty(job);
  refreshAll();
  scheduleProjectSave();
  toast(`أُضيف صندوق يدوي #${job.analysis.boxes.length}.`, "ok", 3000);
}

function deleteSelectedBox(): void {
  if (state.busy) return;
  const job = selectedJob();
  const index = state.selectedBoxIndex;
  if (!job?.analysis || index === null) return;
  if (index < 0 || index >= job.analysis.boxes.length) return;
  job.analysis.boxes.splice(index, 1);
  job.analysis.translations.splice(index, 1);
  job.analysis.sourceTexts.splice(index, 1);
  state.selectedBoxIndex = job.analysis.boxes.length
    ? Math.min(index, job.analysis.boxes.length - 1)
    : null;
  markBoxDirty(job);
  refreshAll();
  scheduleProjectSave();
  toast("تم حذف الصندوق المحدد.", "ok", 2500);
}

function nudgeSelectedBox(dx: number, dy: number): void {
  if (state.busy) return;
  const job = selectedJob();
  const index = state.selectedBoxIndex;
  if (!job?.analysis || index === null) return;
  const box = job.analysis.boxes[index];
  if (!box) return;
  const { width, height } = pageSizeFor(job);
  const moved = moveBoxBy(box, dx, dy, width, height);
  if (moved.x1 === box.x1 && moved.y1 === box.y1) return;
  job.analysis.boxes[index] = moved;
  markBoxDirty(job);
  refreshAll();
  scheduleProjectSave();
}

function onBoxPointerDown(event: PointerEvent): void {
  if (state.busy || !state.boxEditMode || event.button !== 0) return;
  const target = event.target as HTMLElement;
  const overlay = target.closest<HTMLElement>("#box-overlay");
  if (!overlay) return;
  const job = selectedJob();
  if (!job?.analysis) return;

  const { width, height } = pageSizeFor(job);
  const point = pointFromEvent(event, overlay, width, height);
  const handleElement = target.closest<HTMLElement>("[data-handle]");
  const boxElement = target.closest<HTMLElement>("[data-box-index]");
  let mode: BoxDragState["mode"] = "draw";
  let boxIndex: number | null = null;
  let handle: BoxHandle | null = null;
  let startBox: Bbox | null = null;

  if (boxElement) {
    const parsed = Number(boxElement.dataset.boxIndex);
    if (!Number.isInteger(parsed) || !job.analysis.boxes[parsed]) return;
    boxIndex = parsed;
    startBox = { ...job.analysis.boxes[parsed] };
    if (handleElement) {
      const candidate = handleElement.dataset.handle as BoxHandle | undefined;
      if (candidate && (BOX_HANDLES as readonly string[]).includes(candidate)) {
        mode = "resize";
        handle = candidate;
      } else {
        mode = "move";
      }
    } else {
      mode = "move";
    }
  }

  setSelectedBox(boxIndex);
  let draft: HTMLElement | null = null;
  if (mode === "draw") {
    draft = document.createElement("div");
    draft.className = "box-item box-draft";
    applyBoxElementStyle(draft, boxFromPoints(point.x, point.y, point.x, point.y), width, height);
    overlay.appendChild(draft);
  }

  boxDrag = {
    mode,
    pointerId: event.pointerId,
    jobId: job.id,
    overlay,
    boxIndex,
    handle,
    startX: point.x,
    startY: point.y,
    startBox,
    currentBox: mode === "draw" ? boxFromPoints(point.x, point.y, point.x, point.y) : startBox,
    draft,
    moved: false,
    pageWidth: width,
    pageHeight: height,
  };
  try {
    overlay.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture is best-effort; the stage listeners still receive events.
  }
  overlay.classList.add("dragging");
  event.preventDefault();
}

function onBoxPointerMove(event: PointerEvent): void {
  const drag = boxDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  const point = pointFromEvent(event, drag.overlay, drag.pageWidth, drag.pageHeight);
  const dx = point.x - drag.startX;
  const dy = point.y - drag.startY;
  let next: Bbox;

  if (drag.mode === "draw") {
    next = boxFromPoints(drag.startX, drag.startY, point.x, point.y);
    if (drag.draft) {
      applyBoxElementStyle(drag.draft, next, drag.pageWidth, drag.pageHeight);
    }
    drag.moved = true;
  } else {
    if (!drag.startBox) return;
    next =
      drag.mode === "move"
        ? moveBoxBy(drag.startBox, dx, dy, drag.pageWidth, drag.pageHeight)
        : resizeBoxBy(
            drag.startBox,
            drag.handle ?? "se",
            dx,
            dy,
            drag.pageWidth,
            drag.pageHeight,
          );
    const element = drag.overlay.querySelector<HTMLElement>(
      `[data-box-index="${drag.boxIndex}"]`,
    );
    if (element) applyBoxElementStyle(element, next, drag.pageWidth, drag.pageHeight);
    drag.moved = Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5;
  }

  drag.currentBox = next;
  event.preventDefault();
}

function onBoxPointerUp(event: PointerEvent): void {
  const drag = boxDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  try {
    drag.overlay.releasePointerCapture(event.pointerId);
  } catch {
    // Ignore a capture that was already released by the browser.
  }
  drag.overlay.classList.remove("dragging");
  drag.draft?.remove();
  boxDrag = null;

  if (drag.mode === "draw") {
    if (
      drag.currentBox &&
      drag.currentBox.x2 - drag.currentBox.x1 >= BOX_MIN_SIZE &&
      drag.currentBox.y2 - drag.currentBox.y1 >= BOX_MIN_SIZE
    ) {
      const job = state.pages.find((page) => page.id === drag.jobId);
      if (job) addManualBox(job, drag.currentBox);
    }
    event.preventDefault();
    return;
  }

  if (!drag.moved || !drag.currentBox || drag.boxIndex === null) return;
  const job = state.pages.find((page) => page.id === drag.jobId);
  if (!job?.analysis) return;
  const original = job.analysis.boxes[drag.boxIndex];
  if (!original) return;
  job.analysis.boxes[drag.boxIndex] = { ...original, ...drag.currentBox };
  markBoxDirty(job);
  refreshAll();
  scheduleProjectSave();
  event.preventDefault();
}

function onBoxPointerCancel(event: PointerEvent): void {
  const drag = boxDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.overlay.classList.remove("dragging");
  drag.draft?.remove();
  boxDrag = null;
}

function handleBoxEditorKeyDown(event: KeyboardEvent): void {
  if (state.busy || !state.boxEditMode || boxDrag) return;
  const target = event.target as HTMLElement;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  ) {
    return;
  }

  if (event.key === "Delete" || event.key === "Backspace") {
    if (state.selectedBoxIndex !== null) {
      event.preventDefault();
      deleteSelectedBox();
    }
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    if (state.selectedBoxIndex !== null) {
      setSelectedBox(null);
    } else {
      state.boxEditMode = false;
      refreshAll();
    }
    return;
  }
  if (event.key.startsWith("Arrow") && state.selectedBoxIndex !== null) {
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    if (event.key === "ArrowLeft") nudgeSelectedBox(-step, 0);
    if (event.key === "ArrowRight") nudgeSelectedBox(step, 0);
    if (event.key === "ArrowUp") nudgeSelectedBox(0, -step);
    if (event.key === "ArrowDown") nudgeSelectedBox(0, step);
  }
}

async function runTask(label: string, task: () => Promise<void>): Promise<void> {
  if (state.busy) {
    toast("هناك عملية قيد التنفيذ بالفعل. انتظر حتى تنتهي.", "err");
    return;
  }
  state.busy = true;
  state.status = label;
  state.progress = 2;
  refreshAll();

  try {
    await task();
    state.progress = 100;
  } catch (err) {
    state.status = "توقف التنفيذ بسبب خطأ.";
    toast(errorMessage(err), "err", 7000);
  } finally {
    state.busy = false;
    refreshAll();
  }
}

function cloneAnalysis(analysis: PageAnalysis | null): PageAnalysis | null {
  if (!analysis) return null;
  if (typeof structuredClone === "function") return structuredClone(analysis);
  return JSON.parse(JSON.stringify(analysis)) as PageAnalysis;
}

function buildProjectSnapshot(): ProjectSnapshot {
  return {
    version: PROJECT_VERSION,
    savedAt: Date.now(),
    selectedId: state.selectedId,
    settings: projectSettingsFromApp(state.settings),
    pages: state.pages.map((job) => ({
      id: job.id,
      name: job.name,
      width: job.width,
      height: job.height,
      status: projectStatus(job.status),
      stage: job.stage,
      error: job.error,
      dirty: job.dirty,
      analysis: cloneAnalysis(job.analysis),
      image: job.file,
      imageType: job.file.type || "image/png",
    })),
  };
}

function scheduleProjectSave(delay = 650): void {
  if (state.restoringProject) return;
  if (projectSaveTimer !== null) window.clearTimeout(projectSaveTimer);
  projectSaveTimer = window.setTimeout(() => {
    projectSaveTimer = null;
    void saveProjectNow(true);
  }, delay);
}

async function saveProjectNow(silent = true): Promise<boolean> {
  if (state.restoringProject) return false;
  if (projectSaveTimer !== null) {
    window.clearTimeout(projectSaveTimer);
    projectSaveTimer = null;
  }
  if (projectSavePromise) {
    projectSaveQueued = true;
    const result = await projectSavePromise;
    if (projectSaveQueued) {
      projectSaveQueued = false;
      return saveProjectNow(silent);
    }
    return result;
  }
  projectSaveQueued = false;

  let snapshot: ProjectSnapshot;
  try {
    snapshot = buildProjectSnapshot();
  } catch (error) {
    state.projectError = errorMessage(error);
    renderProjectState();
    if (!silent) toast(state.projectError, "err", 7000);
    return false;
  }

  state.projectSaving = true;
  state.projectError = "";
  renderProjectState();

  projectSavePromise = (async () => {
    try {
      await saveProjectSnapshot(snapshot);
      state.projectSavedAt = snapshot.savedAt;
      state.projectError = "";
      return true;
    } catch (error) {
      state.projectError = errorMessage(error);
      if (!silent) toast(state.projectError, "err", 8000);
      return false;
    } finally {
      state.projectSaving = false;
      renderProjectState();
      projectSavePromise = null;
    }
  })();

  return projectSavePromise;
}

async function saveProjectManually(): Promise<void> {
  const saved = await saveProjectNow(false);
  if (saved) toast("تم حفظ المشروع في هذا المتصفح.", "ok");
}

async function exportProject(): Promise<void> {
  if (state.pages.length === 0) {
    toast("أضف صفحات أولًا لتصدير المشروع.", "err");
    return;
  }
  await runTask("تجهيز ملف المشروع…", async () => {
    const snapshot = buildProjectSnapshot();
    const blob = await exportProjectFile(snapshot);
    const date = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `manga-psd-project-${date}.${PROJECT_FILE_EXTENSION}`);
    state.progress = 100;
    state.status = "تم تصدير ملف المشروع.";
    toast("تم تصدير ملف المشروع. لا يحتوي مفاتيح API أو ملفات الخطوط المخصصة.", "ok", 7000);
  });
}

async function jobsFromProjectPages(pages: ProjectPage[]): Promise<PageJob[]> {
  const jobs: PageJob[] = [];
  for (const page of pages) {
    const imageType = page.imageType || page.image.type || "image/png";
    const file = new File([page.image], page.name, { type: imageType });
    const url = URL.createObjectURL(file);
    let width = page.width;
    let height = page.height;
    if (!width || !height) {
      const meta = await loadImageMeta(url).catch(() => ({ width: 0, height: 0 }));
      width = meta.width;
      height = meta.height;
    }
    const analysis = cloneAnalysis(page.analysis);
    jobs.push({
      id: page.id,
      file,
      name: page.name,
      url,
      width,
      height,
      status: page.status === "error" ? "error" : analysis ? "ready" : "queued",
      stage: analysis ? "تم استئناف المشروع — أعد التركيب" : page.stage,
      error: page.error,
      analysis,
      render: null,
      dirty: Boolean(analysis && analysis.translations.some((text) => text.trim())),
    });
  }
  return jobs;
}

function bumpNextId(pages: PageJob[]): void {
  for (const page of pages) {
    const match = /^page-(\d+)$/.exec(page.id);
    if (match) nextId = Math.max(nextId, Number(match[1]) + 1);
  }
}

async function restoreProject(): Promise<void> {
  state.restoringProject = true;
  let needsSave = false;
  try {
    const snapshot = await loadProjectSnapshot();
    if (!snapshot || snapshot.pages.length === 0) return;

    const jobs = await jobsFromProjectPages(snapshot.pages);
    if (jobs.length === 0) return;

    const nextSettings = applyProjectSettings(state.settings, snapshot.settings);
    const fontAvailable = allFontPresets().some((font) => font.id === nextSettings.fontId);
    if (!fontAvailable) {
      nextSettings.fontId = FONT_PRESETS[0].id;
      needsSave = true;
    }
    state.settings = nextSettings;
    saveSettings(state.settings);

    state.pages = jobs;
    state.selectedId = jobs.some((job) => job.id === snapshot.selectedId)
      ? snapshot.selectedId
      : jobs[0].id;
    bumpNextId(jobs);
    state.projectSavedAt = snapshot.savedAt;
    state.projectError = "";
    state.status = `تم استئناف مشروع محفوظ: ${jobs.length} صفحة.`;
    toast(`تم استئناف المشروع المحفوظ (${jobs.length} صفحة).`, "ok", 6000);
    if (!fontAvailable) {
      toast("الخط المخصص المحفوظ في المشروع غير موجود في هذا المتصفح؛ تم استخدام الخط الافتراضي.", "err", 8000);
    }
  } catch (error) {
    state.projectError = errorMessage(error);
    toast(`تعذّر استئناف المشروع المحفوظ: ${state.projectError}`, "err", 8000);
  } finally {
    state.restoringProject = false;
  }
  if (needsSave) scheduleProjectSave(900);
}

async function importProjectFromFile(file: File): Promise<void> {
  if (state.busy) {
    toast("انتظر انتهاء العملية الحالية قبل استيراد مشروع.", "err");
    return;
  }
  if (
    state.pages.length > 0 &&
    !window.confirm("استيراد مشروع سيستبدل الصفحات الحالية غير المحفوظة في التطبيق. هل تريد المتابعة؟")
  ) {
    return;
  }

  await runTask("استيراد المشروع…", async () => {
    const snapshot = await importProjectFile(file);
    if (snapshot.pages.length === 0) {
      throw new Error("المشروع لا يحتوي على صفحات.");
    }
    const jobs = await jobsFromProjectPages(snapshot.pages);
    if (jobs.length === 0) throw new Error("تعذّر تحميل صور المشروع.");

    const nextSettings = applyProjectSettings(state.settings, snapshot.settings);
    const fontAvailable = allFontPresets().some((font) => font.id === nextSettings.fontId);
    if (!fontAvailable) nextSettings.fontId = FONT_PRESETS[0].id;

    for (const page of state.pages) URL.revokeObjectURL(page.url);
    state.settings = nextSettings;
    saveSettings(state.settings);
    state.pages = jobs;
    state.selectedId = jobs.some((job) => job.id === snapshot.selectedId)
      ? snapshot.selectedId
      : jobs[0].id;
    bumpNextId(jobs);
    state.previewTab = "original";
    state.boxEditMode = false;
    state.selectedBoxIndex = null;
    state.projectSavedAt = null;
    state.projectError = "";
    state.progress = 100;
    state.status = `تم استيراد المشروع: ${jobs.length} صفحة.`;

    await saveProjectNow(true);
    if (!fontAvailable) {
      toast("خط المشروع المخصص غير موجود في هذا المتصفح؛ تم استخدام الخط الافتراضي.", "err", 8000);
    }
    toast(`تم استيراد المشروع (${jobs.length} صفحة). أعد التركيب لإنشاء PSD.`, "ok", 7000);
  });
}

const IMAGE_EXTENSION_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

function normalizedImageType(file: File): string | null {
  if (SUPPORTED_IMAGE_TYPES.has(file.type)) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSION_TYPES[extension] ?? null;
}

function filePath(file: File): string {
  const imported = importedPaths.get(file);
  if (imported) return imported;
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relative?.trim() || file.name;
}

function folderNameFromFiles(files: File[]): string {
  for (const file of files) {
    const parts = filePath(file).split("/").filter(Boolean);
    if (parts.length > 1) return parts[0];
  }
  return "";
}

function fileKey(file: File): string {
  return `${filePath(file)}\u0000${file.size}\u0000${file.lastModified}`;
}

const MAX_DROP_DEPTH = 8;
const MAX_DROP_FILES = 1000;

function readDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: FileSystemEntry[] = [];
    const readNext = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(entries);
          return;
        }
        entries.push(...batch);
        readNext();
      }, reject);
    };
    readNext();
  });
}

async function collectEntryFiles(
  entry: FileSystemEntry,
  files: File[],
  path = "",
  depth = 0,
): Promise<void> {
  if (files.length >= MAX_DROP_FILES) return;
  const currentPath = path ? `${path}/${entry.name}` : entry.name;

  if (entry.isFile) {
    try {
      const file = await new Promise<File>((resolve, reject) => {
        (entry as FileSystemFileEntry).file(resolve, reject);
      });
      importedPaths.set(file, currentPath);
      files.push(file);
    } catch {
      // Ignore files the browser cannot read and continue with the rest.
    }
    return;
  }

  if (!entry.isDirectory || depth >= MAX_DROP_DEPTH) return;
  try {
    const children = await readDirectoryEntries(
      (entry as FileSystemDirectoryEntry).createReader(),
    );
    for (const child of children) {
      await collectEntryFiles(child, files, currentPath, depth + 1);
      if (files.length >= MAX_DROP_FILES) break;
    }
  } catch {
    // Ignore unreadable directories and continue with the rest of the drop.
  }
}

interface DroppedFiles {
  files: File[];
  folders: string[];
}

async function filesFromDataTransfer(transfer: DataTransfer): Promise<DroppedFiles> {
  const fallbackFiles = Array.from(transfer.files);
  const entries = Array.from(transfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null);

  if (entries.length === 0) return { files: fallbackFiles, folders: [] };

  const files: File[] = [];
  const folders: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) folders.push(entry.name);
    await collectEntryFiles(entry, files, "", 0);
  }

  if (files.length === 0) return { files: fallbackFiles, folders: [] };
  return { files, folders };
}

interface AddFilesOptions {
  fromFolder?: boolean;
  folderName?: string;
}

async function importFiles(
  files: FileList | File[],
  options: AddFilesOptions = {},
): Promise<void> {
  if (state.busy) {
    toast("انتظر انتهاء العملية الحالية قبل إضافة صفحات.", "err");
    return;
  }
  await runTask("إضافة الصفحات…", () => addFiles(files, options));
}

async function addFiles(files: FileList | File[], options: AddFilesOptions = {}): Promise<void> {
  const incoming = Array.from(files);
  for (const file of incoming) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    if (relative?.trim() && !importedPaths.has(file)) {
      importedPaths.set(file, relative.trim());
    }
  }
  const folderName =
    options.folderName !== undefined
      ? options.folderName
      : options.fromFolder
        ? folderNameFromFiles(incoming)
        : "";
  const existing = new Set(state.pages.map((job) => fileKey(job.file)));
  const candidates: File[] = [];
  let skipped = 0;
  let unsupported = 0;

  for (const file of incoming) {
    const type = normalizedImageType(file);
    if (!type) {
      unsupported++;
      continue;
    }
    const key = fileKey(file);
    if (existing.has(key)) {
      skipped++;
      continue;
    }
    existing.add(key);
    candidates.push(file);
  }

  if (candidates.length === 0) {
    if (skipped > 0) {
      state.status = "كل الصور المختارة مضافة بالفعل.";
      toast("كل الصور المختارة مضافة بالفعل.", "info");
    } else {
      state.status = "لم يتم العثور على صور مدعومة.";
      toast("اختر صور PNG أو JPG أو WebP أو GIF أو AVIF.", "err");
    }
    renderStatus();
    return;
  }

  candidates.sort((a, b) =>
    filePath(a).localeCompare(filePath(b), undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );

  const remaining = MAX_PROJECT_PAGES - state.pages.length;
  if (remaining <= 0) {
    state.status = `وصلت إلى الحد الأقصى (${MAX_PROJECT_PAGES} صفحة).`;
    toast(`لا يمكن إضافة أكثر من ${MAX_PROJECT_PAGES} صفحة في مشروع واحد.`, "err", 7000);
    renderStatus();
    return;
  }

  const limited = candidates.length > remaining;
  const accepted = limited ? candidates.slice(0, remaining) : candidates;
  const list = accepted.map((file) => {
    const type = normalizedImageType(file);
    if (!type || file.type === type) return file;
    const converted = new File([file], file.name, {
      type,
      lastModified: file.lastModified,
    });
    const path = importedPaths.get(file);
    if (path) importedPaths.set(converted, path);
    return converted;
  });

  const folderText = folderName ? ` من مجلد «${folderName}»` : "";
  for (let index = 0; index < list.length; index++) {
    const file = list[index];
    state.status = `قراءة الصفحة ${index + 1} من ${list.length}: ${file.name}`;
    state.progress = Math.round((index / list.length) * 100);
    renderStatus();

    const url = URL.createObjectURL(file);
    const meta = await loadImageMeta(url).catch(() => ({ width: 0, height: 0 }));
    const job: PageJob = {
      id: `page-${nextId++}`,
      file,
      name: file.name,
      url,
      width: meta.width,
      height: meta.height,
      status: "queued",
      stage: "",
      error: "",
      analysis: null,
      render: null,
      dirty: false,
    };
    state.pages.push(job);
    if (!state.selectedId) state.selectedId = job.id;
  }

  const notes: string[] = [];
  if (skipped > 0) notes.push(`تجاهل ${skipped} مكررة`);
  if (unsupported > 0) notes.push(`تجاهل ${unsupported} غير مدعومة`);
  if (limited) notes.push(`توقف عند الحد الأقصى ${MAX_PROJECT_PAGES}`);
  const ignoredText = notes.length > 0 ? ` · ${notes.join(" · ")}` : "";
  state.status = `تمت إضافة ${pageCountText(list.length, true)}${folderText}${ignoredText}.`;
  state.progress = 100;
  refreshAll();
  scheduleProjectSave();
  toast(`تمت إضافة ${pageCountText(list.length, true)}${folderText}${ignoredText}.`, "ok", 5500);
}

async function importDroppedFiles(transfer: DataTransfer): Promise<void> {
  try {
    const dropped = await filesFromDataTransfer(transfer);
    if (dropped.files.length === 0) {
      toast("لم يتم العثور على صور مدعومة في العناصر المسحوبة.", "err");
      return;
    }
    await importFiles(dropped.files, {
      fromFolder: dropped.folders.length > 0,
      folderName: dropped.folders.length === 1 ? dropped.folders[0] : "",
    });
  } catch (error) {
    toast(`تعذّر قراءة العناصر المسحوبة: ${errorMessage(error)}`, "err", 8000);
  }
}

function selectJob(id: string): void {
  if (!state.pages.some((page) => page.id === id)) return;
  state.selectedId = id;
  state.selectedBoxIndex = null;
  const job = selectedJob();
  if (job && !job.render && state.previewTab !== "original") state.previewTab = "original";
  if (job && !job.analysis) state.boxEditMode = false;
  refreshAll();
  scheduleProjectSave();
}

function navigatePreviewPage(direction: -1 | 1): void {
  const index = state.pages.findIndex((page) => page.id === state.selectedId);
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= state.pages.length) return;
  selectJob(state.pages[nextIndex].id);
}

function removeJob(id: string): void {
  if (state.busy) {
    toast("انتظر انتهاء العملية الحالية.", "err");
    return;
  }
  const index = state.pages.findIndex((page) => page.id === id);
  if (index < 0) return;
  if (!window.confirm("حذف هذه الصفحة من القائمة؟")) return;
  URL.revokeObjectURL(state.pages[index].url);
  state.pages.splice(index, 1);
  if (state.selectedId === id) {
    state.selectedId = state.pages[Math.min(index, state.pages.length - 1)]?.id ?? null;
  }
  state.selectedBoxIndex = null;
  if (!selectedJob()?.analysis) state.boxEditMode = false;
  state.status = "تم حذف الصفحة.";
  refreshAll();
  scheduleProjectSave();
}

function clearAll(): void {
  if (state.busy) {
    toast("انتظر انتهاء العملية الحالية.", "err");
    return;
  }
  if (state.pages.length === 0) return;
  if (!window.confirm("مسح كل الصفحات من القائمة؟")) return;
  for (const page of state.pages) URL.revokeObjectURL(page.url);
  state.pages = [];
  state.selectedId = null;
  state.selectedBoxIndex = null;
  state.boxEditMode = false;
  state.progress = 0;
  state.status = "تم مسح القائمة.";
  refreshAll();
  scheduleProjectSave(150);
}

async function downloadSelected(): Promise<void> {
  const job = selectedJob();
  if (!job) {
    toast("اختر صفحة أولًا.", "err");
    return;
  }
  await runTask("تجهيز PSD…", async () => {
    await ensureRender(job);
    if (!job.render) throw new Error("لم يتم إنشاء PSD.");
    downloadBytes(job.render.psd, `${baseName(job.name)}.psd`);
    toast(`تم تنزيل PSD لـ ${job.name}.`, "ok");
  });
}

async function downloadPng(): Promise<void> {
  const job = selectedJob();
  if (!job) {
    toast("اختر صفحة أولًا.", "err");
    return;
  }
  await runTask("تجهيز PNG…", async () => {
    await ensureRender(job);
    if (!job.render) throw new Error("لم يتم إنشاء الصورة النهائية.");
    downloadDataUrl(job.render.finalUrl, `${baseName(job.name)}-ar.png`);
    toast("تم تنزيل الصورة النهائية.", "ok");
  });
}

async function analyzeAll(): Promise<void> {
  await runBatchPipeline(false);
}

async function processAll(): Promise<void> {
  await runBatchPipeline(true);
}

async function runTextBatchPhase(
  manager: RequestManager,
  signal: AbortSignal,
  failures: Array<{ name: string; message: string }>,
): Promise<void> {
  const settings = toPipelineSettings(state.settings).translation;
  const inputs: TranslationBubbleInput[] = [];
  let sourceBubbleCount = 0;
  let existingTranslations = 0;

  for (let pageIndex = 0; pageIndex < state.pages.length; pageIndex++) {
    const job = state.pages[pageIndex];
    if (!job.analysis) continue;
    job.analysis.sourceTexts.forEach((text, boxIndex) => {
      if (!text.trim()) return;
      sourceBubbleCount++;
      if (job.analysis?.translations[boxIndex]?.trim()) {
        existingTranslations++;
        return;
      }
      inputs.push({
        id: buildBubbleId(pageIndex, boxIndex),
        text,
        pageId: job.id,
        pageIndex,
        boxIndex,
      });
    });
  }

  state.batchStats.totalBubbles = sourceBubbleCount;
  state.batchStats.translatedBubbles = existingTranslations;
  state.batchStats.extractedBubbles = sourceBubbleCount;
  if (inputs.length === 0) {
    state.batchStats.remainingBatches = 0;
    state.status = sourceBubbleCount > 0
      ? "كل الفقرات المقروءة مترجمة بالفعل."
      : "لم يتم استخراج نص محليًا. راجع OCR أو فعّل Vision كبديل.";
    return;
  }

  const planned = planTextBatches(inputs, {
    smartBatch: settings.smartBatch,
    batchPages: settings.batchPages,
    tokenBudget: settings.batchTokenBudget,
    maxSegmentsPerBatch: 120,
  });
  state.batchStats.batchesTotal = planned.length;
  state.batchStats.remainingBatches = planned.length;
  state.batchTotal = Math.max(1, planned.length);
  state.batchIndex = 0;
  state.batchPhase = "translate";
  state.status = `ترجمة ${inputs.length} فقرة في ${planned.length} دفعة…`;
  refreshProgress();

  const result = await translateBubbles(inputs, {
    settings,
    manager,
    signal,
    callbacks: {
      onTranslated: (input, translation) => {
        const targetJob = state.pages.find((page) => page.id === input.pageId);
        if (!targetJob?.analysis) return;
        targetJob.analysis.translations[input.boxIndex] = translation;
        targetJob.dirty = true;
        if (targetJob.status === "done") targetJob.status = "ready";
        state.batchStats.translatedBubbles++;
        renderBatchMetrics();
      },
      onCacheHit: () => {
        state.batchStats.cacheHits++;
      },
      onBatchStart: (batch, index, total) => {
        state.batchIndex = index;
        state.batchStats.remainingBatches = Math.max(0, total - index);
        state.status = `ترجمة دفعة ${index + 1} من ${total} (${batch.segments.length} فقرة)…`;
        setProgressPercent(0);
        refreshProgress();
      },
      onBatchComplete: (_batch, index, total, _translated, error) => {
        state.batchStats.batchesDone++;
        state.batchStats.remainingBatches = Math.max(0, total - index - 1);
        if (error) state.batchStats.errors++;
        state.batchIndex = index + 1;
        setProgressPercent(0);
        renderBatchMetrics();
        void scheduleProjectSave();
      },
      onError: () => {
        state.batchStats.errors++;
      },
    },
  });

  state.batchStats.missingBubbles = result.missing.length;
  state.batchStats.batchesTotal = result.batches;
  state.batchStats.remainingBatches = Math.max(
    0,
    result.batches - state.batchStats.batchesDone,
  );
  if (result.missing.length > 0) {
    state.status = `ترجمت ${result.translations.size} فقرة، وبقيت ${result.missing.length} فقرة.`;
  } else {
    state.status = `تمت ترجمة ${result.translations.size} فقرة من ${inputs.length}.`;
  }

  if (settings.useVisionOnOcrFailure) {
    for (const job of state.pages) {
      if (!job.analysis?.ocrFailedBoxes?.length) continue;
      try {
        const translated = await translateVisionFallback(job, manager, signal, settings);
        if (translated > 0) {
          state.batchStats.translatedBubbles += translated;
          state.batchStats.totalBubbles += translated;
        }
      } catch (error) {
        failures.push({ name: job.name, message: errorMessage(error) });
        state.batchStats.errors++;
      }
    }
  }

  for (const job of state.pages) {
    if (job.analysis?.translations.some((text) => text.trim())) {
      job.dirty = true;
      if (job.status === "done") job.status = "ready";
    }
  }
}

async function runVisionBatchPhase(
  manager: RequestManager,
  signal: AbortSignal,
  failures: Array<{ name: string; message: string }>,
): Promise<void> {
  state.batchPhase = "translate";
  state.batchTotal = Math.max(1, state.pages.length);
  state.batchIndex = 0;
  const countTranslations = (job: PageJob): number =>
    job.analysis?.translations.filter((text) => text.trim()).length ?? 0;
  state.batchStats.translatedBubbles = state.pages.reduce(
    (total, job) => total + countTranslations(job),
    0,
  );
  state.batchStats.batchesTotal = Math.max(1, state.pages.length);
  state.batchStats.batchesDone = 0;
  state.batchStats.remainingBatches = state.pages.length;
  let translatedPages = 0;
  for (let index = 0; index < state.pages.length; index++) {
    if (signal.aborted) throw new RequestAbortedError();
    const job = state.pages[index];
    state.batchIndex = index;
    if (!job.analysis || job.analysis.boxes.length === 0) {
      state.batchStats.batchesDone++;
      state.batchStats.remainingBatches = Math.max(0, state.pages.length - index - 1);
      setProgressPercent(100);
      continue;
    }
    state.status = `ترجمة الصفحة ${index + 1} من ${state.pages.length}: ${job.name}`;
    refreshProgress();
    const before = countTranslations(job);
    try {
      await translateJob(job, { manager, signal });
      const after = countTranslations(job);
      if (after > before) translatedPages++;
      state.batchStats.translatedBubbles += Math.max(0, after - before);
      state.batchStats.batchesDone++;
      state.batchStats.remainingBatches = Math.max(0, state.pages.length - index - 1);
    } catch (error) {
      failures.push({ name: job.name, message: errorMessage(error) });
      state.batchStats.errors++;
      if (isAbortError(error) || error instanceof QuotaExhaustedError) throw error;
    }
    setProgressPercent(100);
    refreshProgress();
  }
  state.status = `تمت ترجمة ${translatedPages} صفحة عبر Vision.`;
}

async function runBatchPipeline(render: boolean): Promise<void> {
  if (state.pages.length === 0) {
    toast("أضف صفحات أولًا.", "err");
    return;
  }
  if (state.busy) {
    toast("انتظر انتهاء العملية الحالية.", "err");
    return;
  }

  const manual = state.settings.engine === "manual";
  if (!manual) {
    const settingsError = validateSettings(state.settings);
    if (settingsError) {
      toast(settingsError, "err", 7000);
      return;
    }
  }

  const total = state.pages.length;
  const failures: Array<{ name: string; message: string }> = [];
  const controller = new AbortController();
  state.batchAbort = controller;
  state.busy = true;
  state.batchStats = emptyBatchStats(total);
  state.batchTotal = total;
  state.batchIndex = 0;
  state.batchPhase = "analyze";
  state.progress = 0;
  state.apiNote = "";
  state.status = render
    ? manual
      ? "تركيب كل الصفحات…"
      : "تحليل وترجمة وتركيب كل الصفحات…"
    : "تحليل كل الصفحات…";
  const manager = manual ? null : createRequestManager();
  const unsubscribe = manager ? trackManager(manager) : () => {};
  let analyzed = 0;
  let rendered = 0;
  let skipped = 0;
  let stopped = false;

  refreshAll();

  try {
    for (let index = 0; index < total; index++) {
      if (controller.signal.aborted) throw new RequestAbortedError();
      const job = state.pages[index];
      state.batchIndex = index;
      state.batchPhase = "analyze";
      state.status = `تحليل الصفحة ${index + 1} من ${total}: ${job.name}`;
      refreshProgress();
      try {
        const textOnly = isTextOnlyTranslation(
          toPipelineSettings(state.settings).translation,
        );
        const hasSourceText = job.analysis?.sourceTexts.some((text) => text.trim()) ?? false;
        const hasTranslations =
          job.analysis?.translations.some((text) => text.trim()) ?? false;
        const needsOcrUpgrade =
          textOnly &&
          Boolean(job.analysis) &&
          job.analysis!.boxes.length > 0 &&
          !job.analysis!.ocrEngine &&
          !hasSourceText &&
          !hasTranslations;
        if (!job.analysis || needsOcrUpgrade) {
          await doAnalyze(job);
        }
        analyzed++;
      } catch (error) {
        failures.push({ name: job.name, message: errorMessage(error) });
        state.batchStats.errors++;
      }
      state.batchStats.pagesAnalyzed = analyzed;
      const sourceCount =
        job.analysis?.sourceTexts.filter((text) => text.trim()).length ?? 0;
      state.batchStats.extractedBubbles += sourceCount;
      state.batchStats.ocrFailures += job.analysis?.ocrFailedBoxes?.length ?? 0;
      state.batchStats.totalBubbles += isTextOnlyTranslation(
        toPipelineSettings(state.settings).translation,
      )
        ? sourceCount
        : job.analysis?.boxes.length ?? 0;
      state.batchStats.translatedBubbles +=
        job.analysis?.translations.filter((text) => text.trim()).length ?? 0;
      setProgressPercent(100);
      refreshProgress();
    }

    if (!manual && manager) {
      if (isTextOnlyTranslation(toPipelineSettings(state.settings).translation)) {
        await runTextBatchPhase(manager, controller.signal, failures);
      } else {
        await runVisionBatchPhase(manager, controller.signal, failures);
      }
    }

    if (render) {
      state.batchPhase = "render";
      state.batchTotal = total;
      state.batchIndex = 0;
      for (let index = 0; index < total; index++) {
        if (controller.signal.aborted) throw new RequestAbortedError();
        const job = state.pages[index];
        state.batchIndex = index;
        state.status = `تركيب الصفحة ${index + 1} من ${total}: ${job.name}`;
        refreshProgress();
        if (!job.analysis) {
          setProgressPercent(100);
          continue;
        }
        if (job.render && !job.dirty) {
          skipped++;
          setProgressPercent(100);
          refreshProgress();
          continue;
        }
        try {
          await doRender(job);
          rendered++;
        } catch (error) {
          failures.push({ name: job.name, message: errorMessage(error) });
          state.batchStats.errors++;
        }
        setProgressPercent(100);
        refreshProgress();
      }
    }
  } catch (error) {
    if (isAbortError(error)) {
      stopped = true;
      state.status = "تم إيقاف العملية. الصفحات والترجمات المكتملة محفوظة.";
      toast("تم الإيقاف. يمكنك المتابعة لاحقًا؛ لن تُعاد الصفحات المكتملة.", "info", 9000);
    } else if (error instanceof QuotaExhaustedError) {
      stopped = true;
      state.status =
        "توقفت الترجمة مؤقتًا بسبب حد الحصة. أكمل لاحقًا؛ الترجمات المكتملة محفوظة.";
      toast(error.message, "err", 12000);
    } else {
      stopped = true;
      state.status = `توقف التنفيذ: ${errorMessage(error)}`;
      toast(errorMessage(error), "err", 10000);
    }
  } finally {
    state.batchAbort = null;
    state.busy = false;
    state.batchTotal = 0;
    state.batchIndex = 0;
    state.batchPhase = "analyze";
    unsubscribe();
    refreshAll();
    void refreshCacheStatus();
    scheduleProjectSave(0);
  }

  if (stopped) return;

  const parts = [`تم تحليل ${analyzed} من ${pageCountText(total, true)}`];
  if (!manual) {
    parts.push(
      `ترجمة ${state.batchStats.translatedBubbles} من ${state.batchStats.totalBubbles} فقرة`,
    );
  }
  if (render) {
    parts.push(`تركيب ${rendered} صفحة`);
    if (skipped > 0) parts.push(`تخطي ${skipped} جاهزة`);
  }
  if (failures.length > 0) parts.push(`تعذّر ${failures.length}`);
  if (state.batchStats.cacheHits > 0) parts.push(`ذاكرة ${state.batchStats.cacheHits}`);
  state.status = `${parts.join(" · ")}.`;
  renderStatus();

  if (failures.length > 0) {
    const detail =
      failures.length === 1
        ? `${failures[0].name}: ${failures[0].message}`
        : `تعذّرت ${failures.length} صفحة. راجع حالة الصفحات للتفاصيل.`;
    toast(detail, "err", 10000);
  } else if (rendered > 0 || analyzed > 0) {
    toast(
      render
        ? `تمت معالجة ${pageCountText(rendered || analyzed, true)}.`
        : `تم تحليل ${pageCountText(analyzed, true)} وترجمتها.`,
      "ok",
      6000,
    );
  }
}

async function downloadAll(): Promise<void> {
  if (state.pages.length === 0) {
    toast("أضف صفحات أولًا.", "err");
    return;
  }
  const formatElement = document.getElementById("download-format") as HTMLSelectElement | null;
  const format = (["psd", "png", "both"].includes(formatElement?.value ?? "")
    ? formatElement?.value
    : "psd") as ArchiveFormat;
  const formatLabel = format === "both" ? "PSD وPNG" : format.toUpperCase();

  await runTask(`تجهيز حزمة ${formatLabel}…`, async () => {
    const zip = new JSZip();
    const used = new Set<string>();
    const failures: Array<{ name: string; message: string }> = [];
    let addedPages = 0;
    let addedFiles = 0;

    for (let index = 0; index < state.pages.length; index++) {
      const job = state.pages[index];
      state.status = `تجهيز ${formatLabel} ${index + 1} من ${state.pages.length}: ${job.name}`;
      refreshProgress();
      try {
        await ensureRender(job);
        if (!job.render) {
          failures.push({ name: job.name, message: "لم يتم إنشاء ملفات الإخراج." });
          continue;
        }
        const uniqueName = (suffix: string): string => {
          let name = `${baseName(job.name)}${suffix}`;
          let number = 2;
          while (used.has(name)) name = `${baseName(job.name)}-${number++}${suffix}`;
          used.add(name);
          return name;
        };

        if (format === "psd" || format === "both") {
          zip.file(uniqueName(".psd"), job.render.psd);
          addedFiles++;
        }
        if (format === "png" || format === "both") {
          const png = await fetch(job.render.finalUrl);
          if (!png.ok) throw new Error("تعذّر تحضير صورة PNG النهائية.");
          zip.file(uniqueName("-ar.png"), await png.arrayBuffer());
          addedFiles++;
        }
        addedPages++;
      } catch (err) {
        failures.push({ name: job.name, message: errorMessage(err) });
      }
    }

    if (addedFiles === 0) {
      throw new Error(
        failures.length > 0
          ? `لم يتم إنشاء أي ملف. تعذّر تجهيز ${failures.length} صفحة.`
          : "لم يتم إنشاء أي ملف للتصدير.",
      );
    }

    state.status = "ضغط الملفات…";
    refreshProgress();
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    const archiveName =
      format === "psd"
        ? "manga-psd-pages.zip"
        : format === "png"
          ? "manga-png-pages.zip"
          : "manga-pages.zip";
    downloadBlob(blob, archiveName);
    state.status = `تم تنزيل ${addedFiles} ملف (${formatLabel}) لـ ${addedPages} صفحة داخل ZIP${
      failures.length > 0 ? ` · تعذّر ${failures.length}` : ""
    }.`;
    toast(`تم تنزيل ${addedFiles} ملف داخل ZIP.`, "ok");

    if (failures.length > 0) {
      const detail =
        failures.length === 1
          ? `${failures[0].name}: ${failures[0].message}`
          : `تعذّر تجهيز ${failures.length} صفحة: ${failures
              .slice(0, 3)
              .map((failure) => failure.name)
              .join("، ")}${failures.length > 3 ? "…" : ""}.`;
      toast(detail, "err", 10000);
    }
  });
}

function markRendersDirty(): void {
  for (const job of state.pages) {
    if (!job.render) continue;
    job.dirty = true;
    if (job.status === "done") job.status = "ready";
  }
  scheduleProjectSave();
}

function selectCustomFont(id: string): void {
  if (state.busy) {
    toast("انتظر انتهاء العملية الحالية قبل تغيير الخط.", "err");
    return;
  }
  const preset = allFontPresets().find((font) => font.id === id);
  if (!preset) {
    toast("لم يعد هذا الخط متاحًا. أعد إضافته من جديد.", "err");
    return;
  }
  if (state.settings.fontId === id) return;
  state.settings.fontId = id;
  saveSettings(state.settings);
  markRendersDirty();
  renderSettings();
  refreshAll();
  scheduleProjectSave();
  toast(`تم اختيار الخط «${preset.label}». أعد تركيب الصفحات لتطبيقه على PSD.`, "ok", 6000);
}

function downloadCustomFont(id: string): void {
  const file = getCustomFontDownload(id);
  if (!file) {
    toast("ملف الخط غير متاح في هذا المتصفح.", "err");
    return;
  }
  downloadBlob(
    new Blob([file.bytes as unknown as BlobPart], { type: file.mimeType }),
    file.fileName,
  );
}

async function deleteCustomFont(id: string): Promise<void> {
  if (state.busy) {
    toast("انتظر انتهاء العملية الحالية قبل حذف الخط.", "err");
    return;
  }
  const info = listCustomFonts().find((font) => font.id === id);
  if (!info) return;
  if (!window.confirm(`حذف الخط «${info.label}» من هذا المتصفح؟`)) return;

  const wasSelected = state.settings.fontId === id;
  await removeCustomFont(id);
  if (wasSelected) {
    state.settings.fontId = FONT_PRESETS[0].id;
    saveSettings(state.settings);
    markRendersDirty();
  }
  renderSettings();
  refreshAll();
  scheduleProjectSave();
  toast(`تم حذف الخط «${info.label}».`, "ok");
}

async function addCustomFontFromFile(file: File): Promise<void> {
  if (state.busy) {
    toast("انتظر انتهاء العملية الحالية قبل إضافة خط.", "err");
    return;
  }

  const status = document.getElementById("custom-font-status");
  if (status) status.textContent = `جاري قراءة «${file.name}»…`;

  try {
    const info = await importCustomFont(file);
    state.settings.fontId = info.id;
    saveSettings(state.settings);
    markRendersDirty();
    renderSettings();
    refreshAll();
    scheduleProjectSave();
    toast(`تمت إضافة الخط «${info.label}» واختياره.`, "ok", 6500);
  } catch (error) {
    const message = errorMessage(error);
    const currentStatus = document.getElementById("custom-font-status");
    if (currentStatus) currentStatus.textContent = message;
    toast(message, "err", 8000);
  }
}

function bindEvents(): void {
  const fileInput = document.getElementById("file-input") as HTMLInputElement | null;
  const folderInput = document.getElementById("folder-input") as HTMLInputElement | null;
  const dropzone = document.getElementById("dropzone");
  const pick = document.getElementById("pick-files");
  const pickFolder = document.getElementById("pick-folder");
  const addMore = document.getElementById("add-more");
  const addFolder = document.getElementById("add-folder");

  const openPicker = () => {
    if (!state.busy) fileInput?.click();
  };
  const openFolderPicker = () => {
    if (!state.busy) folderInput?.click();
  };
  pick?.addEventListener("click", (event) => {
    event.stopPropagation();
    openPicker();
  });
  pickFolder?.addEventListener("click", (event) => {
    event.stopPropagation();
    openFolderPicker();
  });
  addMore?.addEventListener("click", openPicker);
  addFolder?.addEventListener("click", openFolderPicker);
  dropzone?.addEventListener("click", openPicker);
  dropzone?.addEventListener("keydown", (event) => {
    if (event.target !== dropzone) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openPicker();
    }
  });

  fileInput?.addEventListener("change", () => {
    const files = fileInput.files ? Array.from(fileInput.files) : [];
    fileInput.value = "";
    if (files.length > 0) void importFiles(files);
  });
  folderInput?.addEventListener("change", () => {
    const files = folderInput.files ? Array.from(folderInput.files) : [];
    folderInput.value = "";
    if (files.length > 0) void importFiles(files, { fromFolder: true });
  });

  for (const type of ["dragenter", "dragover"]) {
    dropzone?.addEventListener(type, (event) => {
      event.preventDefault();
      const dragEvent = event as DragEvent;
      if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = "copy";
      dropzone.classList.add("drag");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    dropzone?.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove("drag");
    });
  }
  dropzone?.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("drag");
    const transfer = (event as DragEvent).dataTransfer;
    if (transfer) void importDroppedFiles(transfer);
  });

  document.getElementById("analyze-all")?.addEventListener("click", () => void analyzeAll());
  document.getElementById("process-all")?.addEventListener("click", () => void processAll());
  document.getElementById("stop-batch")?.addEventListener("click", () => {
    if (!state.batchAbort) return;
    state.status = "جارٍ إيقاف العملية بعد الطلب الحالي…";
    state.batchAbort.abort();
    renderStatus();
  });
  document.getElementById("download-all")?.addEventListener("click", () => void downloadAll());
  document.getElementById("clear-all")?.addEventListener("click", clearAll);

  document.getElementById("save-project")?.addEventListener("click", () => void saveProjectManually());
  document.getElementById("export-project")?.addEventListener("click", () => void exportProject());
  const projectInput = document.getElementById("project-input") as HTMLInputElement | null;
  document.getElementById("import-project")?.addEventListener("click", () => projectInput?.click());
  projectInput?.addEventListener("change", () => {
    const file = projectInput.files?.[0];
    projectInput.value = "";
    if (file) void importProjectFromFile(file);
  });

  document.getElementById("toggle-box-editor")?.addEventListener("click", () => toggleBoxEditor());

  document.getElementById("pages-grid")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>("[data-page-id]");
    if (!card) return;
    const id = card.dataset.pageId;
    if (!id) return;
    const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
    if (action === "remove") {
      removeJob(id);
      return;
    }
    if (action === "analyze") {
      const job = state.pages.find((page) => page.id === id);
      if (job) void runTask(`تحليل ${job.name}…`, () => doAnalyze(job));
      return;
    }
    if (action === "render") {
      const job = state.pages.find((page) => page.id === id);
      if (job) void runTask(`تركيب ${job.name}…`, () => doRender(job));
      return;
    }
    if (action === "download") {
      state.selectedId = id;
      refreshAll();
      void downloadSelected();
      return;
    }
    selectJob(id);
  });

  document.getElementById("pages-previous-page")?.addEventListener("click", () => {
    navigatePreviewPage(-1);
  });

  document.getElementById("pages-next-page")?.addEventListener("click", () => {
    navigatePreviewPage(1);
  });

  document.getElementById("preview-tabs")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-tab]");
    if (!button || button.disabled) return;
    state.previewTab = button.dataset.tab as PreviewTab;
    if (state.previewTab !== "original") state.boxEditMode = false;
    renderPreview();
    renderTranslations();
  });

  document.getElementById("preview-previous-page")?.addEventListener("click", () => {
    navigatePreviewPage(-1);
  });

  document.getElementById("preview-next-page")?.addEventListener("click", () => {
    navigatePreviewPage(1);
  });

  document.getElementById("preview-side")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>("[data-preview-action]")?.dataset
      .previewAction;
    if (action === "psd") void downloadSelected();
    if (action === "png") void downloadPng();
    if (action === "edit-boxes") toggleBoxEditor();
    if (action === "render") {
      const job = selectedJob();
      if (job) void runTask(`تركيب ${job.name}…`, () => doRender(job));
    }
    const boxAction = target.closest<HTMLElement>("[data-box-action]")?.dataset.boxAction;
    if (boxAction === "delete") deleteSelectedBox();
    if (boxAction === "translate") void retranslateSelected();
  });

  document.getElementById("translations-body")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>("tr[data-box-index]");
    if (!row) return;
    const index = Number(row.dataset.boxIndex);
    if (Number.isInteger(index)) setSelectedBox(index);
  });

  document.getElementById("translations-body")?.addEventListener("input", (event) => {
    const target = event.target as HTMLElement;
    const job = selectedJob();
    if (!job?.analysis) return;

    const source = target.closest<HTMLTextAreaElement>("textarea[data-source-index]");
    if (source) {
      const index = Number(source.dataset.sourceIndex);
      if (!Number.isInteger(index) || index < 0) return;
      job.analysis.sourceTexts[index] = source.value;
      job.dirty = true;
      if (job.status === "done") job.status = "ready";
      renderPreview();
      renderStatus();
      scheduleProjectSave();
      return;
    }

    const textarea = target.closest<HTMLTextAreaElement>("textarea[data-index]");
    if (!textarea) return;
    const index = Number(textarea.dataset.index);
    if (!Number.isInteger(index) || index < 0) return;
    job.analysis.translations[index] = textarea.value;
    job.dirty = true;
    if (job.status === "done") job.status = "ready";
    renderPreview();
    renderStatus();
    scheduleProjectSave();
  });

  const previewStage = document.getElementById("preview-stage");
  previewStage?.addEventListener("pointerdown", onBoxPointerDown);
  previewStage?.addEventListener("pointermove", onBoxPointerMove);
  previewStage?.addEventListener("pointerup", onBoxPointerUp);
  previewStage?.addEventListener("pointercancel", onBoxPointerCancel);
  document.addEventListener("keydown", handleBoxEditorKeyDown);

  window.addEventListener("beforeunload", () => {
    void saveProjectNow(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void saveProjectNow(true);
  });

  document.getElementById("reanalyze-selected")?.addEventListener("click", () => {
    const job = selectedJob();
    if (job) void runTask(`إعادة تحليل ${job.name}…`, () => doAnalyze(job));
  });
  document.getElementById("retranslate-selected")?.addEventListener("click", () => {
    void retranslateSelected();
  });
  document.getElementById("render-selected")?.addEventListener("click", () => {
    const job = selectedJob();
    if (job) void runTask(`تركيب ${job.name}…`, () => doRender(job));
  });
  document.getElementById("download-selected")?.addEventListener("click", () => void downloadSelected());

  document.getElementById("settings-body")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("#custom-font-add")) {
      event.preventDefault();
      (document.getElementById("custom-font-input") as HTMLInputElement | null)?.click();
      return;
    }
    if (target.closest("#clear-translation-cache")) {
      event.preventDefault();
      void (async () => {
        if (!window.confirm("مسح كل الترجمات المحفوظة في ذاكرة هذا المتصفح؟")) return;
        try {
          await clearTranslationCache();
          await refreshCacheStatus();
          toast("تم مسح ذاكرة الترجمة. لن تتأثر الترجمات الظاهرة في المشروع.", "ok", 6000);
        } catch (error) {
          toast(errorMessage(error), "err", 7000);
        }
      })();
      return;
    }

    const actionButton = target.closest<HTMLElement>("[data-font-action]");
    if (!actionButton) return;
    event.preventDefault();
    const action = actionButton.dataset.fontAction;
    const id = actionButton.dataset.fontId;
    if (!action || !id) return;
    if (action === "select") selectCustomFont(id);
    if (action === "download") downloadCustomFont(id);
    if (action === "delete") void deleteCustomFont(id);
  });

  document.getElementById("settings-body")?.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const key = target.dataset.setting as keyof AppSettings | undefined;
    if (!key) return;
    updateSetting(key, target);
  });
  document.getElementById("settings-body")?.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (target instanceof HTMLInputElement && target.id === "custom-font-input") {
      const file = target.files?.[0];
      target.value = "";
      if (file) void addCustomFontFromFile(file);
      return;
    }

    const key = target.dataset.setting as keyof AppSettings | undefined;
    if (!key) return;
    updateSetting(key, target);
    if (key === "engine" || key === "fontId") renderSettings();
    if (key === "engine" || RENDER_SETTING_KEYS.has(key)) refreshAll();
    else updateControls();
  });
}

const RENDER_SETTING_KEYS = new Set<keyof AppSettings>([
  "fontId",
  "psdRtl",
  "psdRasterPreview",
  "psdCompress",
  "inpaintMethod",
]);

function updateSetting(
  key: keyof AppSettings,
  target: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): void {
  const value =
    target instanceof HTMLInputElement && target.type === "checkbox"
      ? target.checked
      : target instanceof HTMLInputElement && target.type === "number"
        ? Number(target.value)
        : target.value;

  const previous = state.settings[key];
  (state.settings as unknown as Record<string, unknown>)[key] = value;
  const saved = saveSettings(state.settings);
  if (!saved && (key === "geminiApiKey" || key === "openaiApiKey")) {
    toast("تعذّر حفظ المفتاح في تخزين المتصفح. لن يبقى بعد إعادة تحميل الصفحة.", "err", 8000);
  }
  if (previous !== value && RENDER_SETTING_KEYS.has(key)) markRendersDirty();
  scheduleProjectSave();
}

async function main(): Promise<void> {
  await loadCustomFonts();
  const currentFont = selectedFont(state.settings);
  if (currentFont.id !== state.settings.fontId) {
    state.settings.fontId = currentFont.id;
    saveSettings(state.settings);
  }
  renderShell();
  await restoreProject();
  bindEvents();
  const restoredFont = selectedFont(state.settings);
  if (restoredFont.id !== state.settings.fontId) {
    state.settings.fontId = restoredFont.id;
    saveSettings(state.settings);
  }
  renderSettings();
  renderHelp();
  refreshAll();
  renderProjectState();
}

void main();
