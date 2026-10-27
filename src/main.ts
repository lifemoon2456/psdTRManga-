import "./style.css";
import JSZip from "jszip";
import { DefaultConfig, FONT_PRESETS } from "./lib/configs";
import { analyzePage, renderPage, type PipelineStage } from "./lib/pipeline";
import { downloadBytes } from "./lib/psd";
import {
  baseName,
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

const state = {
  pages: [] as PageJob[],
  selectedId: null as string | null,
  settings: loadSettings(),
  busy: false,
  status: "جاهز. أضف صفحات مانجا للبدء.",
  progress: 0,
  previewTab: "original" as PreviewTab,
};

let nextId = 1;

const STAGE_PROGRESS: Record<PipelineStage, number> = {
  detect: 14,
  translate: 44,
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
          <button id="analyze-all" class="ghost">تحليل الكل</button>
          <button id="process-all" class="primary">معالجة الكل</button>
          <button id="download-all">تنزيل كل PSD</button>
        </div>
      </header>

      <div class="workspace">
        <main class="main">
          <section class="panel">
            <div class="panel-head">
              <h2>إضافة صفحات</h2>
              <span class="badge">صور PNG / JPG / WebP</span>
            </div>
            <div class="panel-body">
              <div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="اختيار صفحات مانجا">
                <h3>اسحب صفحات المانجا هنا أو اضغط للاختيار</h3>
                <p>يمكنك اختيار عدة صفحات مرة واحدة. الصفحات لا تُرفع إلى أي خادم من هذا التطبيق.</p>
                <button type="button" class="primary" id="pick-files">اختيار الصفحات</button>
                <div class="hint">أول تشغيل قد ينزّل موديلات الكشف والتنظيف. انتظر حتى يكتمل التنزيل.</div>
              </div>
              <input id="file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple hidden />

              <div style="margin-top: 14px">
                <div class="status-line">
                  <strong id="status-text">جاهز</strong>
                  <span id="progress-text">0%</span>
                </div>
                <div class="progress" style="margin-top: 7px"><i id="progress-bar"></i></div>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2>الصفحات <span id="page-count" class="badge">0</span></h2>
              <div style="display:flex; gap:6px; flex-wrap:wrap">
                <button class="small" id="add-more">إضافة</button>
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
              <div class="preview-tabs" id="preview-tabs">
                <button class="small active" data-tab="original">الأصلية</button>
                <button class="small" data-tab="cleaned" disabled>المنظفة</button>
                <button class="small" data-tab="final" disabled>النهائية</button>
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
    ["gemini", "Gemini Vision — جودة عالية"],
    ["openai", "OpenAI-compatible Vision — محلي أو سحابي"],
    ["manual", "يدوي — كشف فقط ثم أكتب الترجمة"],
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

  const fontOptions = FONT_PRESETS.map(
    (item) =>
      `<option value="${escapeHtml(item.id)}" ${
        s.fontId === item.id ? "selected" : ""
      }>${escapeHtml(item.label)}</option>`,
  ).join("");

  const geminiFields = `
    <div class="field">
      <label for="gemini-key">مفتاح Gemini API</label>
      <input id="gemini-key" data-setting="geminiApiKey" type="password" autocomplete="off"
        value="${escapeHtml(s.geminiApiKey)}" placeholder="AIza..." />
    </div>
    <div class="field">
      <label for="gemini-model">موديل Gemini</label>
      <input id="gemini-model" data-setting="geminiModel" list="gemini-model-list"
        value="${escapeHtml(s.geminiModel)}" placeholder="gemini-2.5-flash" />
      <datalist id="gemini-model-list">
        <option value="gemini-2.5-flash"></option>
        <option value="gemini-2.5-pro"></option>
        <option value="gemini-2.0-flash"></option>
      </datalist>
      <div class="hint">للدقة العالية جرّب gemini-2.5-pro. للسرعة والتكلفة الأقل استخدم flash.</div>
    </div>
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
    <div class="field">
      <label for="engine">محرك الترجمة</label>
      <select id="engine" data-setting="engine">${engineOptions}</select>
    </div>
    ${engineSpecific}

    <div class="divider"></div>

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

    <div class="divider"></div>

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

    <div class="divider"></div>

    <div class="field">
      <label for="font">خط النص العربي</label>
      <select id="font" data-setting="fontId">${fontOptions}</select>
      <div class="hint">
        ${font.file ? `<a href="${escapeHtml(font.file)}" download>تنزيل ملف الخط</a> ثم ثبّته على جهازك قبل فتح PSD.` : "ثبّت الخط على جهازك قبل فتح PSD."}
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
  `;
}

function renderHelp(): void {
  const body = document.getElementById("help-body");
  if (!body) return;
  body.innerHTML = `
    <ol style="margin:0; padding-inline-start:18px; color:var(--muted); font-size:12px; line-height:1.9">
      <li>أضف صفحات المانجا (يفضل دقة عالية).</li>
      <li>اختر لغة المصدر ومحرك الترجمة، ثم «تحليل الكل».</li>
      <li>راجع النص الأصلي والترجمة في الجدول وعدّل ما تريد.</li>
      <li>اضغط «تركيب وتحديث PSD» ثم نزّل الملف.</li>
    </ol>
    <div class="divider"></div>
    <div class="notice info" style="margin-bottom:10px">
      ملف PSD يحتوي خلفية منظفة + طبقة نص قابلة للتعديل لكل فقاعة. عند تفعيل «طبقة المعاينة النقطية»
      تظهر نسخة عربية مطابقة للمتصفح فوق طبقات التعديل، وتبقى طبقات النص ظاهرة أسفلها ومزوّدة بصورة نقطية.
      أخفِ طبقة Preview من لوحة الطبقات لتعديل النص الحي.
      ملفات الخطوط لا تُضمّن داخل PSD؛ ثبّت الخط المختار على جهاز فتح الملف.
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
    grid.innerHTML = `<div class="empty">لم تُضف صفحات بعد. اسحب صور المانجا إلى الأعلى.</div>`;
    updateControls();
    return;
  }

  grid.innerHTML = state.pages
    .map((job) => {
      const active = job.id === state.selectedId ? " active" : "";
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

      return `
        <div class="page-card${active}" data-page-id="${escapeHtml(job.id)}">
          <div class="page-thumb">
            <img src="${escapeHtml(job.url)}" alt="${escapeHtml(job.name)}" loading="lazy" />
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
    })
    .join("");

  updateControls();
}

function renderPreview(): void {
  const stage = document.getElementById("preview-stage");
  const side = document.getElementById("preview-side");
  const tabs = document.querySelectorAll<HTMLButtonElement>("[data-tab]");
  if (!stage || !side) return;

  const job = selectedJob();
  if (!job) {
    stage.innerHTML = `<div class="empty">اختر صفحة لعرض المعاينة.</div>`;
    side.innerHTML = "";
    tabs.forEach((tab) => {
      tab.disabled = tab.dataset.tab !== "original";
    });
    return;
  }

  const hasRender = Boolean(job.render);
  let tab = state.previewTab;
  if ((tab === "cleaned" || tab === "final") && !hasRender) tab = "original";
  state.previewTab = tab;

  tabs.forEach((button) => {
    const value = button.dataset.tab as PreviewTab;
    button.classList.toggle("active", value === tab);
    button.disabled = value !== "original" && !hasRender;
  });

  const src =
    tab === "final"
      ? job.render?.finalUrl
      : tab === "cleaned"
        ? job.render?.cleanedUrl
        : job.url;

  if (!src) {
    stage.innerHTML = `<div class="empty">لا توجد صورة معاينة لهذه الحالة بعد.</div>`;
  } else {
    stage.innerHTML = `<img src="${escapeHtml(src)}" alt="معاينة ${escapeHtml(job.name)}" />`;
  }

  const translated = job.analysis
    ? job.analysis.translations.filter((text) => text.trim()).length
    : 0;
  const boxCount = job.analysis?.boxes.length ?? 0;
  const psdSize = job.render ? formatBytes(job.render.psd.byteLength) : "—";

  side.innerHTML = `
    <div class="stat"><b>الملف</b><span>${escapeHtml(job.name)}</span></div>
    <div class="stat"><b>الأبعاد</b><span>${job.width || "?"} × ${job.height || "?"}</span></div>
    <div class="stat"><b>مناطق النص</b><span>${boxCount}</span></div>
    <div class="stat"><b>ترجمات غير فارغة</b><span>${translated}</span></div>
    <div class="stat"><b>حجم PSD</b><span>${psdSize}</span></div>
    ${
      job.dirty
        ? `<div class="notice">تم تعديل الترجمة بعد آخر تركيب. اضغط «تركيب وتحديث PSD» لتطبيق التعديلات.</div>`
        : ""
    }
    ${job.error ? `<div class="notice err">${escapeHtml(job.error)}</div>` : ""}
    <button class="primary" data-preview-action="psd" ${state.busy ? "disabled" : ""}>تنزيل PSD</button>
    <button data-preview-action="png" ${state.busy ? "disabled" : ""}>تنزيل PNG</button>
    <button data-preview-action="render" ${state.busy ? "disabled" : ""}>إعادة التركيب</button>
  `;
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
      const source = sourceTexts[index]?.trim() || "—";
      const translation = translations[index] ?? "";
      return `
        <tr>
          <td>${index + 1}</td>
          <td>
            <div class="source-text">${escapeHtml(source)}</div>
            <div class="hint" style="margin-top:4px">ثقة ${box.confidence.toFixed(2)}</div>
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
    <div class="table-wrap">
      <table class="translations">
        <thead>
          <tr>
            <th>#</th>
            <th>النص الأصلي (مراجعة)</th>
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
  setDisabled("clear-all", state.busy || !hasPages);
  setDisabled("add-more", state.busy);
  setDisabled("reanalyze-selected", state.busy || !job);
  setDisabled("render-selected", state.busy || !job || !job.analysis);
  setDisabled("download-selected", state.busy || !job);
}

function setProgress(stage: PipelineStage, message?: string): void {
  state.progress = STAGE_PROGRESS[stage] ?? state.progress;
  if (message) state.status = message;
  renderStatus();
}

function refreshAll(): void {
  renderPages();
  renderPreview();
  renderTranslations();
  renderStatus();
}

function refreshProgress(): void {
  renderPages();
  renderPreview();
  renderStatus();
}

async function doAnalyze(job: PageJob): Promise<void> {
  const settingsError = validateSettings(state.settings);
  if (settingsError) throw new Error(settingsError);

  job.status = "analyzing";
  job.error = "";
  job.stage = "تهيئة الكشف…";
  job.render = null;
  job.dirty = false;
  state.progress = 0;
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
    job.stage =
      analysis.boxes.length > 0
        ? `${analysis.boxes.length} منطقة نص`
        : "لم يتم العثور على نص";
    state.progress = 100;
    state.status =
      analysis.boxes.length > 0
        ? `تم تحليل ${job.name}: ${analysis.boxes.length} منطقة.`
        : `لم يتم العثور على نص في ${job.name}.`;
    if (analysis.boxes.length === 0) {
      toast("لم يتم العثور على مناطق نص. جرّب تقليل حد الثقة.", "err", 6000);
    }
  } catch (err) {
    job.status = "error";
    job.error = errorMessage(err);
    job.stage = "";
    state.progress = 0;
    state.status = `فشل تحليل ${job.name}.`;
    throw err;
  } finally {
    refreshAll();
  }
}

async function doRender(job: PageJob): Promise<void> {
  if (!job.analysis) {
    await doAnalyze(job);
  }
  if (!job.analysis) throw new Error("لا توجد نتائج تحليل لهذه الصفحة.");

  if (
    job.analysis.boxes.length > 0 &&
    !job.analysis.translations.some((text) => text.trim())
  ) {
    throw new Error("لا توجد ترجمات غير فارغة. عدّل الجدول أو أعد التحليل أولًا.");
  }

  job.status = "rendering";
  job.error = "";
  job.stage = "تنظيف الصفحة…";
  state.progress = 0;
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
    state.progress = 100;
    state.status = `تم إنشاء PSD لـ ${job.name}.`;
  } catch (err) {
    job.status = "error";
    job.error = errorMessage(err);
    job.stage = "";
    state.progress = 0;
    state.status = `فشل تركيب ${job.name}.`;
    throw err;
  } finally {
    refreshAll();
  }
}

async function ensureAnalysis(job: PageJob): Promise<void> {
  if (!job.analysis) await doAnalyze(job);
}

async function ensureRender(job: PageJob): Promise<void> {
  await ensureAnalysis(job);
  if (!job.render || job.dirty) await doRender(job);
}

async function runTask(label: string, task: () => Promise<void>): Promise<void> {
  if (state.busy) {
    toast("هناك عملية قيد التنفيذ بالفعل. انتظر حتى تنتهي.", "err");
    return;
  }
  state.busy = true;
  state.status = label;
  state.progress = Math.max(state.progress, 2);
  refreshAll();

  try {
    await task();
  } catch (err) {
    state.status = "توقف التنفيذ بسبب خطأ.";
    toast(errorMessage(err), "err", 7000);
  } finally {
    state.busy = false;
    refreshAll();
  }
}

async function addFiles(files: FileList | File[]): Promise<void> {
  const list = Array.from(files).filter((file) => file.type.startsWith("image/"));
  if (list.length === 0) {
    toast("اختر صور PNG أو JPG أو WebP.", "err");
    return;
  }

  for (const file of list) {
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

  state.status = `تمت إضافة ${list.length} صفحة.`;
  refreshAll();
  toast(`تمت إضافة ${list.length} صفحة.`, "ok");
}

function selectJob(id: string): void {
  if (!state.pages.some((page) => page.id === id)) return;
  state.selectedId = id;
  const job = selectedJob();
  if (job && !job.render && state.previewTab !== "original") state.previewTab = "original";
  refreshAll();
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
  state.status = "تم حذف الصفحة.";
  refreshAll();
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
  state.progress = 0;
  state.status = "تم مسح القائمة.";
  refreshAll();
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
  if (state.pages.length === 0) {
    toast("أضف صفحات أولًا.", "err");
    return;
  }
  await runTask("تحليل كل الصفحات…", async () => {
    for (let index = 0; index < state.pages.length; index++) {
      const job = state.pages[index];
      state.status = `تحليل الصفحة ${index + 1} من ${state.pages.length}: ${job.name}`;
      refreshProgress();
      try {
        await doAnalyze(job);
      } catch (err) {
        toast(`${job.name}: ${errorMessage(err)}`, "err", 7000);
      }
    }
    state.status = "انتهى تحليل الصفحات.";
  });
}

async function processAll(): Promise<void> {
  if (state.pages.length === 0) {
    toast("أضف صفحات أولًا.", "err");
    return;
  }
  await runTask("معالجة كل الصفحات…", async () => {
    for (let index = 0; index < state.pages.length; index++) {
      const job = state.pages[index];
      state.status = `معالجة الصفحة ${index + 1} من ${state.pages.length}: ${job.name}`;
      refreshProgress();
      try {
        await ensureRender(job);
      } catch (err) {
        toast(`${job.name}: ${errorMessage(err)}`, "err", 7000);
      }
    }
    state.status = "انتهت معالجة الصفحات.";
  });
}

async function downloadAll(): Promise<void> {
  if (state.pages.length === 0) {
    toast("أضف صفحات أولًا.", "err");
    return;
  }
  await runTask("تجهيز ملف ZIP…", async () => {
    const zip = new JSZip();
    const used = new Set<string>();
    let added = 0;

    for (let index = 0; index < state.pages.length; index++) {
      const job = state.pages[index];
      state.status = `تجهيز PSD ${index + 1} من ${state.pages.length}: ${job.name}`;
      refreshProgress();
      try {
        await ensureRender(job);
        if (!job.render) continue;
        let name = `${baseName(job.name)}.psd`;
        let suffix = 2;
        while (used.has(name)) name = `${baseName(job.name)}-${suffix++}.psd`;
        used.add(name);
        zip.file(name, job.render.psd);
        added++;
      } catch (err) {
        toast(`${job.name}: ${errorMessage(err)}`, "err", 7000);
      }
    }

    if (added === 0) throw new Error("لم يتم إنشاء أي PSD.");
    state.status = "ضغط الملفات…";
    refreshProgress();
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    downloadBlob(blob, "manga-psd-pages.zip");
    state.status = `تم تنزيل ${added} ملف PSD داخل ZIP.`;
    toast(`تم تنزيل ${added} ملف PSD.`, "ok");
  });
}

function bindEvents(): void {
  const fileInput = document.getElementById("file-input") as HTMLInputElement | null;
  const dropzone = document.getElementById("dropzone");
  const pick = document.getElementById("pick-files");
  const addMore = document.getElementById("add-more");

  const openPicker = () => fileInput?.click();
  pick?.addEventListener("click", (event) => {
    event.stopPropagation();
    openPicker();
  });
  addMore?.addEventListener("click", openPicker);
  dropzone?.addEventListener("click", openPicker);
  dropzone?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openPicker();
    }
  });

  fileInput?.addEventListener("change", async () => {
    if (fileInput.files) await addFiles(fileInput.files);
    fileInput.value = "";
  });

  for (const type of ["dragenter", "dragover"]) {
    dropzone?.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add("drag");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    dropzone?.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove("drag");
    });
  }
  dropzone?.addEventListener("drop", async (event) => {
    const dragEvent = event as DragEvent;
    if (dragEvent.dataTransfer?.files) await addFiles(dragEvent.dataTransfer.files);
  });

  document.getElementById("analyze-all")?.addEventListener("click", () => void analyzeAll());
  document.getElementById("process-all")?.addEventListener("click", () => void processAll());
  document.getElementById("download-all")?.addEventListener("click", () => void downloadAll());
  document.getElementById("clear-all")?.addEventListener("click", clearAll);

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

  document.getElementById("preview-tabs")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-tab]");
    if (!button || button.disabled) return;
    state.previewTab = button.dataset.tab as PreviewTab;
    renderPreview();
  });

  document.getElementById("preview-side")?.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-preview-action]")?.dataset
      .previewAction;
    if (action === "psd") void downloadSelected();
    if (action === "png") void downloadPng();
    if (action === "render") {
      const job = selectedJob();
      if (job) void runTask(`تركيب ${job.name}…`, () => doRender(job));
    }
  });

  document.getElementById("translations-body")?.addEventListener("input", (event) => {
    const textarea = (event.target as HTMLElement).closest<HTMLTextAreaElement>("textarea[data-index]");
    if (!textarea) return;
    const job = selectedJob();
    if (!job?.analysis) return;
    const index = Number(textarea.dataset.index);
    if (!Number.isInteger(index) || index < 0) return;
    job.analysis.translations[index] = textarea.value;
    job.dirty = true;
    if (job.status === "done") job.status = "ready";
    renderPreview();
    renderStatus();
  });

  document.getElementById("reanalyze-selected")?.addEventListener("click", () => {
    const job = selectedJob();
    if (job) void runTask(`إعادة تحليل ${job.name}…`, () => doAnalyze(job));
  });
  document.getElementById("render-selected")?.addEventListener("click", () => {
    const job = selectedJob();
    if (job) void runTask(`تركيب ${job.name}…`, () => doRender(job));
  });
  document.getElementById("download-selected")?.addEventListener("click", () => void downloadSelected());

  document.getElementById("settings-body")?.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const key = target.dataset.setting as keyof AppSettings | undefined;
    if (!key) return;
    updateSetting(key, target);
  });
  document.getElementById("settings-body")?.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const key = target.dataset.setting as keyof AppSettings | undefined;
    if (!key) return;
    updateSetting(key, target);
    if (key === "engine") renderSettings();
  });
}

function updateSetting(key: keyof AppSettings, target: HTMLInputElement | HTMLSelectElement): void {
  const value =
    target instanceof HTMLInputElement && target.type === "checkbox"
      ? target.checked
      : target instanceof HTMLInputElement && target.type === "number"
        ? Number(target.value)
        : target.value;

  (state.settings as unknown as Record<string, unknown>)[key] = value;
  saveSettings(state.settings);
}

function main(): void {
  renderShell();
  renderSettings();
  renderHelp();
  renderPages();
  renderPreview();
  renderTranslations();
  renderStatus();
  bindEvents();
}

main();
