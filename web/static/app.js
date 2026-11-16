"use strict";
const $ = (id) => document.getElementById(id);
const states = {
  queued: "Sırada",
  running: "Analiz sürüyor",
  succeeded: "Tamamlandı",
  failed: "Tamamlanamadı",
};
const stages = {
  validating: "Proje kontrol ediliyor",
  mining: "Git geçmişi inceleniyor",
  historical_metrics: "Geçmiş ölçümler hesaplanıyor",
  training: "Model değerlendiriliyor",
  current_files: "Mevcut dosyalar inceleniyor",
  completed: "Analiz tamamlandı",
};
const reasons = {
  environment_directory: "Sanal ortam dosyası",
  excluded_by_filter: "Seçtiğin filtreyle hariç tutuldu",
  outside_repository: "Proje dışında",
  missing_file: "Dosya bulunamadı",
  unreadable_file: "Dosya okunamadı",
  empty_file: "Boş dosya",
  invalid_python: "Python sözdizimi geçersiz",
};
const errors = {
  empty_history:
    "Bu Git deposunda henüz commit yok. Önce ilk commit’i oluşturup yeniden dene.",
  missing_repository: "Proje klasörü bulunamadı. Tam klasör yolunu kontrol et.",
  git_error: "Bu klasör bir Git deposu değil veya Git tarafından okunamıyor.",
  repository_root_required: "Git deposunun ana klasörünü seç.",
  history_failed: "Projenin Git geçmişi okunamadı.",
  interrupted:
    "Uygulama kapandığı için analiz yarıda kaldı. Yeniden başlatabilirsin.",
  internal_error:
    "Analiz sırasında beklenmeyen bir hata oluştu. Yeniden deneyebilirsin.",
};
const ruleMeta = {
  complex_function: {
    label: "Karmaşık fonksiyon",
    suggestion:
      "Dallanma sayısı yüksek. Fonksiyonu testlerle birlikte daha küçük, anlamlı adımlara ayırmayı değerlendir.",
  },
  large_file: {
    label: "Büyük dosya",
    suggestion:
      "Dosyanın farklı sorumluluklarını daha küçük modüllere ayırmayı değerlendir.",
  },
  dense_expressions: {
    label: "Yoğun ifadeler",
    suggestion:
      "Karmaşık ifadeleri sadeleştir; ara sonuçlara anlamlı isimler ver.",
  },
};
function ruleLabel(rule) {
  return ruleMeta[rule]?.label || rule;
}
const ruleMetricSpec = {
  complex_function: {
    key: "cyclomatic_complexity_max",
    label: "En yüksek karmaşıklık",
    decimals: 1,
  },
  large_file: {
    key: "loc",
    label: "Kod satırı (LOC)",
    decimals: 0,
  },
  dense_expressions: {
    key: "halstead_difficulty",
    label: "Halstead zorluğu",
    decimals: 1,
  },
};
function indexByPath(items) {
  const map = new Map();
  for (const item of items || []) {
    if (item?.path) map.set(item.path, item);
  }
  return map;
}
function indexFindingsByRule(file) {
  const map = new Map();
  for (const finding of file?.result?.maintainability_findings || []) {
    if (finding?.rule && !map.has(finding.rule)) map.set(finding.rule, finding);
  }
  return map;
}
function compareReports(olderReport, newerReport, olderJob, newerJob) {
  const olderFiles = indexByPath(olderReport.files);
  const newerFiles = indexByPath(newerReport.files);
  const olderSkipped = indexByPath(olderReport.skipped_files);
  const newerSkipped = indexByPath(newerReport.skipped_files);
  const allPaths = Array.from(
    new Set([...olderFiles.keys(), ...newerFiles.keys()]),
  ).sort((a, b) => a.localeCompare(b, "tr"));

  const addedFindings = [];
  const removedFindings = [];
  const persistingFindings = [];
  const unmatchedFiles = [];
  let matchedFileCount = 0;

  for (const path of allPaths) {
    const oldFile = olderFiles.get(path);
    const newFile = newerFiles.get(path);
    if (!oldFile || !newFile) {
      unmatchedFiles.push({
        path,
        presentIn: newFile ? "newer" : "older",
        skippedReason: newFile
          ? olderSkipped.get(path)?.reason || null
          : newerSkipped.get(path)?.reason || null,
        file: newFile || oldFile,
      });
      continue;
    }
    matchedFileCount += 1;
    const oldRules = indexFindingsByRule(oldFile);
    const newRules = indexFindingsByRule(newFile);

    for (const [rule, finding] of newRules.entries()) {
      if (!oldRules.has(rule)) {
        addedFindings.push({
          path,
          rule,
          finding,
          metrics: newFile.metrics || {},
        });
      } else {
        const spec = ruleMetricSpec[rule];
        const olderValue =
          spec && typeof oldFile.metrics?.[spec.key] === "number"
            ? oldFile.metrics[spec.key]
            : null;
        const newerValue =
          spec && typeof newFile.metrics?.[spec.key] === "number"
            ? newFile.metrics[spec.key]
            : null;
        const delta =
          olderValue !== null && newerValue !== null
            ? newerValue - olderValue
            : null;
        persistingFindings.push({
          path,
          rule,
          metricLabel: spec?.label || "İlgili metrik",
          decimals: spec?.decimals ?? 2,
          olderValue,
          newerValue,
          delta,
          olderFinding: oldRules.get(rule),
          newerFinding: finding,
        });
      }
    }
    for (const [rule, finding] of oldRules.entries()) {
      if (!newRules.has(rule)) {
        removedFindings.push({
          path,
          rule,
          finding,
          metrics: oldFile.metrics || {},
        });
      }
    }
  }

  return {
    olderJob,
    newerJob,
    olderReport,
    newerReport,
    matchedFileCount,
    addedFindings,
    removedFindings,
    persistingFindings,
    unmatchedFiles,
  };
}
let currentId = null,
  viewVersion = 0,
  pollTimer = null,
  files = [],
  skippedFiles = [],
  activeView = "list",
  lastJobs = [],
  compareMode = false,
  compareSelection = [];
function text(id, value) {
  $(id).textContent = value;
}
function projectName(path) {
  return path.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop() || path;
}
function normalizeRepoPath(path) {
  return (path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
async function api(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error(
      "Uygulamaya ulaşılamıyor. Yerel servisin çalıştığını kontrol edip yeniden dene.",
    );
  }
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? "Analiz kuyruğu dolu. Bir analiz tamamlanınca yeniden dene."
        : response.status === 422
          ? "Analiz seçeneklerini kontrol et."
          : typeof body.detail === "string"
            ? body.detail
            : "İşlem tamamlanamadı.",
    );
  return body;
}
function showError(error) {
  text("form-error", error.message);
  $("form-error").hidden = false;
}
function updateCompareBar() {
  $("compare-bar").hidden = !compareMode;
  $("compare-mode-btn").setAttribute("aria-pressed", String(compareMode));
  $("compare-mode-btn").classList.toggle("active", compareMode);
  const count = compareSelection.length;
  $("run-compare").disabled = count !== 2;
  $("run-compare").textContent = `Karşılaştır (${count}/2)`;
  if (count === 0) {
    text("compare-hint", "Aynı depodan 2 tamamlanmış analiz seç.");
  } else if (count === 1) {
    text(
      "compare-hint",
      `${projectName(compareSelection[0].payload?.repo_path || "Proje")} için 2. analizi seç.`,
    );
  } else {
    text(
      "compare-hint",
      `${projectName(compareSelection[0].payload?.repo_path || "Proje")} · 2 analiz seçildi.`,
    );
  }
}
function toggleCompareSelection(job) {
  const existingIndex = compareSelection.findIndex((item) => item.id === job.id);
  if (existingIndex >= 0) {
    compareSelection.splice(existingIndex, 1);
  } else {
    if (job.state !== "succeeded") return;
    if (compareSelection.length > 0) {
      const targetRepo = normalizeRepoPath(compareSelection[0].payload?.repo_path);
      if (normalizeRepoPath(job.payload?.repo_path) !== targetRepo) return;
    }
    if (compareSelection.length >= 2) {
      compareSelection = [compareSelection[1], job];
    } else {
      compareSelection.push(job);
    }
  }
  updateCompareBar();
  renderHistory(lastJobs);
}
function renderHistory(jobs) {
  lastJobs = jobs;
  $("history").replaceChildren();
  if (!jobs.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Henüz analiz yok.";
    $("history").append(p);
  }
  const anchorRepo =
    compareMode && compareSelection.length > 0
      ? normalizeRepoPath(compareSelection[0].payload?.repo_path)
      : null;
  for (const job of jobs) {
    const button = document.createElement("button");
    button.type = "button";
    const selectedIdx = compareSelection.findIndex((item) => item.id === job.id);
    const isSelected = selectedIdx >= 0;
    const isCompatible =
      !compareMode ||
      (job.state === "succeeded" &&
        (anchorRepo === null ||
          normalizeRepoPath(job.payload?.repo_path) === anchorRepo));
    button.className = [
      !compareMode && job.id === currentId ? "active" : "",
      compareMode && isSelected ? "compare-selected" : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (compareMode) {
      button.setAttribute("aria-pressed", String(isSelected));
      button.disabled = !isCompatible && !isSelected;
    }
    const name = document.createElement("strong");
    name.textContent = projectName(job.payload?.repo_path || "Proje");
    const detail = document.createElement("small");
    const dateStr = new Date(job.created).toLocaleString("tr-TR", {
      dateStyle: "short",
      timeStyle: "short",
    });
    detail.textContent = `${states[job.state] || job.state} · ${dateStr}`;
    button.append(name, detail);
    if (compareMode && isSelected) {
      const badge = document.createElement("span");
      badge.className = "compare-order-badge";
      badge.textContent = `${selectedIdx + 1}. seçim`;
      button.append(badge);
    }
    button.addEventListener("click", () => {
      if (compareMode) toggleCompareSelection(job);
      else selectJob(job.id);
    });
    $("history").append(button);
  }
}
async function refreshHistory() {
  const jobs = await api("/api/scans");
  const validIds = new Set(jobs.map((j) => j.id));
  compareSelection = compareSelection.filter((j) => validIds.has(j.id));
  updateCompareBar();
  renderHistory(jobs);
  return jobs;
}
async function selectJob(id) {
  currentId = id;
  const version = ++viewVersion;
  clearTimeout(pollTimer);
  history.replaceState(null, "", `#scan=${encodeURIComponent(id)}`);
  $("results").hidden = true;
  $("compare-view").hidden = true;
  $("welcome").hidden = true;
  $("job-panel").hidden = false;
  $("form-error").hidden = true;
  text("job-title", "Analiz yükleniyor…");
  text("job-state", "Yükleniyor");
  text("job-description", "");
  $("job-progress").hidden = false;
  $("job-progress").removeAttribute("value");
  async function poll() {
    try {
      const job = await api(`/api/scans/${encodeURIComponent(id)}`);
      if (version !== viewVersion) return;
      text("job-title", projectName(job.payload.repo_path));
      text("job-state", states[job.state]);
      const p = job.progress;
      text(
        "job-description",
        job.state === "failed"
          ? errors[job.error?.code] ||
              job.error?.message ||
              "Analiz tamamlanamadı."
          : job.state === "queued"
            ? "Sıradaki analiz bekleniyor."
            : (stages[p?.stage] || "Analiz hazırlanıyor…") +
              (p?.total ? ` · ${p.completed} / ${p.total}` : ""),
      );
      $("job-progress").hidden = ["failed", "succeeded"].includes(job.state);
      if (p?.total) {
        $("job-progress").max = p.total;
        $("job-progress").value = p.completed;
      } else $("job-progress").removeAttribute("value");
      if (job.state === "succeeded") {
        const report = await api(`/api/scans/${id}/report`);
        if (version !== viewVersion) return;
        renderReport(report, job);
        await refreshHistory();
      } else if (job.state === "failed") await refreshHistory();
      else pollTimer = setTimeout(poll, 1200);
    } catch (error) {
      if (version === viewVersion) {
        showError(error);
        $("job-progress").hidden = true;
      }
    }
  }
  await poll();
}
function formatDateTime(value) {
  if (!value) return "Tarih bilinmiyor";
  return new Date(value).toLocaleString("tr-TR", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
function renderCompareDateCard(label, job, report) {
  const card = document.createElement("div");
  card.className = "card compare-date-card";
  const eyebrow = document.createElement("span");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = label;
  const time = document.createElement("strong");
  time.textContent = formatDateTime(job.created);
  const meta = document.createElement("p");
  meta.className = "muted";
  const parts = [`Durum: ${report.status || "bilinmiyor"}`];
  if (report.repository_state?.head) {
    parts.push(`HEAD: ${report.repository_state.head.slice(0, 7)}`);
  }
  parts.push(`İncelenen: ${(report.files || []).length} dosya`);
  meta.textContent = parts.join(" · ");
  card.append(eyebrow, time, meta);
  return card;
}
function formatMetricValue(value, decimals = 1) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "Karşılaştırılamıyor";
  }
  return decimals === 0 ? String(Math.round(value)) : value.toFixed(decimals);
}
function formatDeltaValue(delta, decimals = 1) {
  if (typeof delta !== "number" || Number.isNaN(delta)) {
    return { text: "Karşılaştırılamıyor", cls: "delta-unknown" };
  }
  if (delta === 0) return { text: "0", cls: "delta-flat" };
  const formatted =
    decimals === 0 ? String(Math.round(delta)) : delta.toFixed(decimals);
  return delta > 0
    ? { text: `+${formatted}`, cls: "delta-up" }
    : { text: formatted, cls: "delta-down" };
}
function renderDiffFindingList(containerId, items, emptyMessage) {
  const container = $(containerId);
  container.replaceChildren();
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "empty-message";
    p.textContent = emptyMessage;
    container.append(p);
    return;
  }
  for (const item of items) {
    const card = document.createElement("div");
    card.className = "diff-item";
    const top = document.createElement("div");
    top.className = "diff-item-top";
    const path = document.createElement("code");
    path.className = "diff-path";
    path.textContent = item.path;
    const badges = document.createElement("div");
    badges.className = "rule-badges";
    const ruleBadge = document.createElement("span");
    ruleBadge.className = `rule-badge rule-${item.rule}`;
    ruleBadge.textContent = ruleLabel(item.rule);
    badges.append(ruleBadge);
    const spec = ruleMetricSpec[item.rule];
    if (spec && typeof item.metrics?.[spec.key] === "number") {
      const metricChip = document.createElement("span");
      metricChip.className = "metric-chip";
      metricChip.textContent = `${spec.label}: ${formatMetricValue(item.metrics[spec.key], spec.decimals)}`;
      badges.append(metricChip);
    }
    top.append(path, badges);
    card.append(top);
    if (item.finding?.reason) {
      const reason = document.createElement("p");
      reason.className = "diff-reason";
      reason.textContent = item.finding.reason;
      card.append(reason);
    }
    if (item.finding?.suggestion) {
      const suggestion = document.createElement("p");
      suggestion.className = "diff-suggestion";
      suggestion.textContent = item.finding.suggestion;
      card.append(suggestion);
    }
    container.append(card);
  }
}
function renderPersistingFindings(items) {
  const tbody = $("cmp-persisting-rows");
  tbody.replaceChildren();
  $("cmp-persisting-empty").hidden = items.length > 0;
  for (const item of items) {
    const tr = document.createElement("tr");
    const tdPath = document.createElement("td");
    tdPath.dataset.label = "Dosya yolu";
    const code = document.createElement("code");
    code.className = "diff-path";
    code.textContent = item.path;
    tdPath.append(code);

    const tdRule = document.createElement("td");
    tdRule.dataset.label = "Bulgu türü";
    const badge = document.createElement("span");
    badge.className = `rule-badge rule-${item.rule}`;
    badge.textContent = ruleLabel(item.rule);
    tdRule.append(badge);

    const tdMetric = document.createElement("td");
    tdMetric.dataset.label = "İlgili metrik";
    tdMetric.textContent = item.metricLabel;

    const tdOld = document.createElement("td");
    tdOld.dataset.label = "Önceki";
    tdOld.textContent = formatMetricValue(item.olderValue, item.decimals);

    const tdNew = document.createElement("td");
    tdNew.dataset.label = "Yeni";
    tdNew.textContent = formatMetricValue(item.newerValue, item.decimals);

    const tdDelta = document.createElement("td");
    tdDelta.dataset.label = "Değişim";
    const deltaInfo = formatDeltaValue(item.delta, item.decimals);
    const deltaBadge = document.createElement("span");
    deltaBadge.className = `delta-badge ${deltaInfo.cls}`;
    deltaBadge.textContent = deltaInfo.text;
    tdDelta.append(deltaBadge);

    tr.append(tdPath, tdRule, tdMetric, tdOld, tdNew, tdDelta);
    tbody.append(tr);
  }
}
function renderUnmatchedFiles(items) {
  const container = $("cmp-unmatched-list");
  container.replaceChildren();
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "empty-message";
    p.textContent = "Tüm analiz edilen dosyalar iki raporda da eşleşti.";
    container.append(p);
    return;
  }
  for (const item of items) {
    const card = document.createElement("div");
    card.className = "diff-item unmatched-item";
    const top = document.createElement("div");
    top.className = "diff-item-top";
    const path = document.createElement("code");
    path.className = "diff-path";
    path.textContent = item.path;
    const badge = document.createElement("span");
    badge.className = "unmatched-badge";
    badge.textContent = "Karşılaştırılamıyor";
    top.append(path, badge);
    const reason = document.createElement("p");
    reason.className = "diff-reason";
    const side =
      item.presentIn === "newer"
        ? "Yalnızca yeni raporda analiz edildi"
        : "Yalnızca önceki raporda analiz edildi";
    const skipText = item.skippedReason
      ? ` (diğer raporda atlanma nedeni: ${reasons[item.skippedReason] || item.skippedReason})`
      : "";
    reason.textContent = `${side}${skipText}.`;
    card.append(top, reason);
    container.append(card);
  }
}
function renderComparison(diff) {
  $("welcome").hidden = true;
  $("job-panel").hidden = true;
  $("results").hidden = true;
  $("form-error").hidden = true;
  $("compare-view").hidden = false;

  const repoDisplay =
    diff.newerReport.repository ||
    diff.newerJob.payload?.repo_path ||
    diff.olderJob.payload?.repo_path ||
    "Depo";
  text("compare-repo-name", projectName(repoDisplay));
  text("compare-repo-path", repoDisplay);

  $("compare-dates").replaceChildren(
    renderCompareDateCard("ÖNCEKİ ANALİZ", diff.olderJob, diff.olderReport),
    renderCompareDateCard("YENİ ANALİZ", diff.newerJob, diff.newerReport),
  );

  const warnings = [];
  if (
    normalizeRepoPath(diff.olderReport.repository) !==
    normalizeRepoPath(diff.newerReport.repository)
  ) {
    warnings.push(
      "Seçilen iki raporun depo yolları birebir aynı değil; eşleşmeyen dosyalar karşılaştırılamıyor olarak işaretlendi.",
    );
  }
  if (
    diff.olderReport.status !== "complete" ||
    diff.newerReport.status !== "complete"
  ) {
    warnings.push(
      "En az bir rapor kısmi veya boş tamamlandı; eksik dosyalar karşılaştırma dışında tutuldu.",
    );
  }
  if (diff.matchedFileCount === 0) {
    warnings.push(
      "İki raporda ortak analiz edilmiş dosya bulunamadı; dosya düzeyinde bulgu karşılaştırması yapılamıyor.",
    );
  }
  $("compare-warnings").replaceChildren();
  $("compare-warnings").hidden = warnings.length === 0;
  for (const msg of warnings) {
    const notice = document.createElement("div");
    notice.className = "notice warning-notice";
    notice.textContent = msg;
    $("compare-warnings").append(notice);
  }

  text("cmp-added-count", diff.addedFindings.length);
  text("cmp-removed-count", diff.removedFindings.length);
  text("cmp-persisting-count", diff.persistingFindings.length);
  text("cmp-unmatched-count", diff.unmatchedFiles.length);

  renderDiffFindingList(
    "cmp-added-list",
    diff.addedFindings,
    "Eşleşen dosyalarda yeni ortaya çıkan bulgu yok.",
  );
  renderDiffFindingList(
    "cmp-removed-list",
    diff.removedFindings,
    "Önceki rapora göre artık görünmeyen bulgu yok.",
  );
  renderPersistingFindings(diff.persistingFindings);
  renderUnmatchedFiles(diff.unmatchedFiles);
}
async function openComparison(jobA, jobB) {
  const ordered = [jobA, jobB].sort(
    (a, b) => new Date(a.created).getTime() - new Date(b.created).getTime(),
  );
  const [olderJob, newerJob] = ordered;
  $("run-compare").disabled = true;
  $("form-error").hidden = true;
  try {
    const [olderReport, newerReport] = await Promise.all([
      api(`/api/scans/${encodeURIComponent(olderJob.id)}/report`),
      api(`/api/scans/${encodeURIComponent(newerJob.id)}/report`),
    ]);
    const diff = compareReports(olderReport, newerReport, olderJob, newerJob);
    renderComparison(diff);
  } catch (error) {
    showError(error);
  } finally {
    updateCompareBar();
  }
}
function renderReport(report, job) {
  files = report.files || [];
  skippedFiles = report.skipped_files || [];
  $("results").hidden = false;
  $("search").value = "";
  $("findings-only").checked = false;
  $("rule-filter").value = "all";
  $("file-sort").value = "original";
  $("include-skipped-map").checked = true;
  text("project-name", projectName(report.repository || job.payload.repo_path));
  const status = {
    complete: "Analiz tamamlandı",
    partial: "Bazı dosyalar incelenemedi",
    empty: "İncelenecek dosya bulunamadı",
  };
  text(
    "scan-info",
    `${status[report.status] || "Analiz tamamlandı"} · ${new Date(job.created).toLocaleString("tr-TR")}`,
  );
  const metaItems = [];
  if (report.scan?.max_commits != null) {
    metaItems.push(`Commit limiti: ${report.scan.max_commits}`);
  }
  if (report.scan?.observation_commits != null) {
    metaItems.push(`Gözlem penceresi: ${report.scan.observation_commits}`);
  }
  if (report.repository_state?.head) {
    metaItems.push(`HEAD: ${report.repository_state.head.slice(0, 7)}`);
  }
  if (report.repository_state?.tracked_changes) {
    metaItems.push("Çalışma ağacında kaydedilmemiş değişiklik var");
  }
  $("scan-meta").replaceChildren();
  for (const label of metaItems) {
    const badge = document.createElement("span");
    badge.className = "meta-chip";
    badge.textContent = label;
    $("scan-meta").append(badge);
  }
  const warnings = report.warnings || [];
  $("scan-warnings").replaceChildren();
  $("scan-warnings").hidden = warnings.length === 0;
  for (const warning of warnings) {
    const item = document.createElement("div");
    item.className = "notice warning-notice";
    item.textContent = warning.message || warning.code;
    $("scan-warnings").append(item);
  }
  const summary = report.summary || {};
  const analyzedCount = summary.analyzed_files ?? files.length;
  const filesWithFindings = files.filter(
    (file) => file.result.maintainability_findings.length > 0,
  ).length;
  const totalFindings = files.reduce(
    (n, file) => n + file.result.maintainability_findings.length,
    0,
  );
  text("file-count", analyzedCount);
  text(
    "file-count-detail",
    report.scan?.file
      ? `Seçili dosya: ${report.scan.file}`
      : "Mevcut Python dosyaları",
  );
  text("finding-count", totalFindings);
  text(
    "finding-files-detail",
    filesWithFindings > 0
      ? `${filesWithFindings} dosyada bakım bulgusu`
      : "Bakım bulgusu saptanmadı",
  );
  text("skip-count", summary.skipped_files ?? (report.skipped_files?.length || 0));
  text("training-count", summary.training_revisions ?? 0);
  text(
    "model-status-detail",
    report.evaluation_details?.status === "evaluated"
      ? "Risk modeli değerlendirildi"
      : "Risk modeli kullanılamıyor",
  );
  text(
    "model-notice",
    report.evaluation_details?.status === "evaluated"
      ? "Risk sıralaması deneyseldir; hata olasılığı veya teknik borç süresi değildir. Bakım bulguları ayrı kurallarla değerlendirilir."
      : "Bu analizde risk modeli için yeterli ve çeşitli veri bulunamadı. Bakım bulgularını ve dosya ölçümlerini inceleyebilirsin.",
  );
  $("json-download").href = `/api/scans/${job.id}/report?format=json`;
  $("csv-download").href = `/api/scans/${job.id}/report?format=csv`;
  $("skipped-list").replaceChildren();
  for (const item of report.skipped_files || []) {
    const li = document.createElement("li");
    li.textContent = `${item.path} — ${reasons[item.reason] || item.reason}`;
    $("skipped-list").append(li);
  }
  if (!report.skipped_files?.length) {
    const li = document.createElement("li");
    li.textContent = "Atlanan dosya yok.";
    $("skipped-list").append(li);
  }
  text("evaluation", report.model_evaluation || "Değerlendirme bulunmuyor.");
  renderFiles();
}
function matchesSearch(file, query) {
  if (!query) return true;
  if (file.path.toLocaleLowerCase("tr-TR").includes(query)) return true;
  return file.result.maintainability_findings.some((finding) => {
    const haystack = [
      finding.rule,
      ruleLabel(finding.rule),
      finding.reason || "",
      finding.suggestion || "",
    ]
      .join(" ")
      .toLocaleLowerCase("tr-TR");
    return haystack.includes(query);
  });
}
function renderFiles() {
  const query = $("search").value.trim().toLocaleLowerCase("tr-TR");
  const findingsOnly = $("findings-only").checked;
  const ruleFilter = $("rule-filter").value;
  const sort = $("file-sort").value;
  const selected = files.filter((file) => {
    const fileFindings = file.result.maintainability_findings;
    if (!matchesSearch(file, query)) return false;
    if (findingsOnly && fileFindings.length === 0) return false;
    if (ruleFilter === "none" && fileFindings.length > 0) return false;
    if (
      ruleFilter !== "all" &&
      ruleFilter !== "none" &&
      !fileFindings.some((finding) => finding.rule === ruleFilter)
    ) {
      return false;
    }
    return true;
  });
  if (sort !== "original")
    selected.sort((a, b) => {
      const byName = a.path.localeCompare(b.path, "tr");
      if (sort === "findings")
        return (
          b.result.maintainability_findings.length -
            a.result.maintainability_findings.length || byName
        );
      if (sort === "complexity")
        return (
          b.metrics.cyclomatic_complexity_max -
            a.metrics.cyclomatic_complexity_max || byName
        );
      if (sort === "loc") return b.metrics.loc - a.metrics.loc || byName;
      if (sort === "risk") {
        const ra = a.result.risk_score;
        const rb = b.result.risk_score;
        if (ra == null && rb == null) return byName;
        if (ra == null) return 1;
        if (rb == null) return -1;
        return rb - ra || byName;
      }
      return byName;
    });
  const canShowSkipped = !findingsOnly && ruleFilter === "all";
  $("include-skipped-map").disabled = !canShowSkipped;
  const filteredSkipped =
    canShowSkipped && $("include-skipped-map").checked
      ? skippedFiles.filter((item) => {
          if (!query) return true;
          const haystack = `${item.path} ${reasons[item.reason] || item.reason}`
            .toLocaleLowerCase("tr-TR");
          return haystack.includes(query);
        })
      : [];
  renderRepoMap(selected, filteredSkipped, {
    expandAll: Boolean(query || findingsOnly || ruleFilter !== "all"),
  });
  $("clear-filters").hidden =
    !query && !findingsOnly && ruleFilter === "all" && sort === "original";
  const skippedSuffix =
    activeView === "map" && filteredSkipped.length > 0
      ? ` (+${filteredSkipped.length} atlanan)`
      : "";
  text("visible-count", `${selected.length} / ${files.length} dosya${skippedSuffix}`);
  $("file-rows").replaceChildren();
  $("empty-files").hidden =
    activeView === "map"
      ? selected.length > 0 || filteredSkipped.length > 0
      : selected.length > 0;
  for (const file of selected) {
    const fileFindings = file.result.maintainability_findings;
    const row = document.createElement("tr");
    row.className =
      fileFindings.length > 0 ? "file-row has-findings-row" : "file-row";
    row.addEventListener("click", (event) => {
      if (event.target.closest("button") || window.getSelection()?.toString()) {
        return;
      }
      openFile(file);
    });

    const pathCell = document.createElement("td");
    pathCell.dataset.label = "Dosya yolu";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-button";
    button.textContent = file.path;
    button.addEventListener("click", () => openFile(file));
    pathCell.append(button);

    const typeCell = document.createElement("td");
    typeCell.dataset.label = "Bulgu türü";
    const badgeWrap = document.createElement("div");
    badgeWrap.className = "rule-badges";
    if (fileFindings.length === 0) {
      const clean = document.createElement("span");
      clean.className = "rule-badge rule-clean";
      clean.textContent = "Bulgu yok";
      badgeWrap.append(clean);
    } else {
      for (const finding of fileFindings) {
        const badge = document.createElement("span");
        badge.className = `rule-badge rule-${finding.rule}`;
        badge.textContent = ruleLabel(finding.rule);
        badgeWrap.append(badge);
      }
    }
    typeCell.append(badgeWrap);

    const metricsCell = document.createElement("td");
    metricsCell.dataset.label = "İlgili metrikler";
    const metricsWrap = document.createElement("div");
    metricsWrap.className = "row-metrics";
    const riskText =
      file.result.risk_score == null
        ? "Risk: Hesaplanamadı"
        : `Risk sırası: ${Number(file.result.risk_score).toFixed(3)}`;
    for (const item of [
      `LOC: ${file.metrics.loc}`,
      `Maks. karmaşıklık: ${file.metrics.cyclomatic_complexity_max}`,
      riskText,
    ]) {
      const chip = document.createElement("span");
      chip.className = "metric-chip";
      chip.textContent = item;
      metricsWrap.append(chip);
    }
    metricsCell.append(metricsWrap);

    const suggestionCell = document.createElement("td");
    suggestionCell.dataset.label = "Öneri";
    suggestionCell.className = "suggestion-cell";
    if (fileFindings.length === 0) {
      const empty = document.createElement("span");
      empty.className = "muted";
      empty.textContent = "—";
      suggestionCell.append(empty);
    } else {
      const primary = fileFindings[0];
      const textWrap = document.createElement("span");
      textWrap.className = "suggestion-text";
      textWrap.textContent =
        primary.suggestion || ruleMeta[primary.rule]?.suggestion || "—";
      suggestionCell.append(textWrap);
      if (fileFindings.length > 1) {
        const more = document.createElement("span");
        more.className = "more-findings";
        more.textContent = `+${fileFindings.length - 1} ek öneri`;
        suggestionCell.append(more);
      }
    }

    row.append(pathCell, typeCell, metricsCell, suggestionCell);
    $("file-rows").append(row);
  }
}
function openFile(file) {
  text("detail-path", file.path);
  const m = file.metrics || {};
  const metricCards = [
    ["Kod satırı (LOC)", m.loc ?? "—"],
    ["Maks. karmaşıklık", m.cyclomatic_complexity_max ?? "—"],
    [
      "Ort. karmaşıklık",
      m.cyclomatic_complexity != null
        ? Number(m.cyclomatic_complexity).toFixed(2)
        : "—",
    ],
    ["Fonksiyon sayısı", m.num_functions ?? "—"],
    [
      "Halstead zorluğu",
      m.halstead_difficulty != null
        ? Number(m.halstead_difficulty).toFixed(2)
        : "—",
    ],
    [
      "Halstead hacmi",
      m.halstead_volume != null ? Number(m.halstead_volume).toFixed(1) : "—",
    ],
    [
      "Deneysel risk sırası",
      file.result.risk_score == null
        ? "Hesaplanamadı"
        : Number(file.result.risk_score).toFixed(3),
    ],
  ];
  $("detail-metrics").replaceChildren();
  for (const [label, value] of metricCards) {
    const card = document.createElement("div");
    card.className = "detail-metric";
    const span = document.createElement("span");
    span.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = String(value);
    card.append(span, strong);
    $("detail-metrics").append(card);
  }
  text(
    "detail-risk-note",
    file.result.risk_score_kind === "relative_ranking_not_calibrated_probability"
      ? "Deneysel risk sırası yalnızca göreli sıralama içindir; kalibre edilmiş hata olasılığı değildir."
      : "Bu analizde risk sıralaması hesaplanamadı; aşağıdaki bakım bulguları kural temellidir.",
  );
  $("detail-findings").replaceChildren();
  for (const finding of file.result.maintainability_findings) {
    const box = document.createElement("div");
    box.className = "finding";
    const head = document.createElement("div");
    head.className = "finding-head";
    const badge = document.createElement("span");
    badge.className = `rule-badge rule-${finding.rule}`;
    badge.textContent = ruleLabel(finding.rule);
    const code = document.createElement("code");
    code.textContent = finding.rule;
    head.append(badge, code);
    const suggestion = document.createElement("p");
    suggestion.className = "finding-suggestion";
    suggestion.textContent =
      finding.suggestion || ruleMeta[finding.rule]?.suggestion || "";
    const evidence = document.createElement("p");
    evidence.className = "finding-evidence";
    evidence.textContent = finding.reason;
    box.append(head, suggestion, evidence);
    $("detail-findings").append(box);
  }
  if (!file.result.maintainability_findings.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Bu dosyada mevcut kurallara göre bakım bulgusu yok.";
    $("detail-findings").append(p);
  }
  $("file-dialog").showModal();
}
function createTreeNode(name, path) {
  return {
    name,
    path,
    folders: new Map(),
    files: [],
    analyzedCount: 0,
    skippedCount: 0,
    findingCount: 0,
    findingsFilesCount: 0,
  };
}
function insertIntoRepoTree(root, rawPath, entry) {
  const normalized = (rawPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) return;
  let current = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const segment = parts[i];
    const folderPath = parts.slice(0, i + 1).join("/");
    if (!current.folders.has(segment)) {
      current.folders.set(segment, createTreeNode(segment, folderPath));
    }
    current = current.folders.get(segment);
  }
  current.files.push({
    name: parts[parts.length - 1],
    path: normalized,
    ...entry,
  });
}
function finalizeRepoTree(node) {
  const sortedFolders = Array.from(node.folders.values())
    .sort((a, b) => a.name.localeCompare(b.name, "tr"))
    .map(finalizeRepoTree);
  const sortedFiles = [...node.files].sort((a, b) =>
    a.name.localeCompare(b.name, "tr"),
  );
  let analyzedCount = 0;
  let skippedCount = 0;
  let findingCount = 0;
  let findingsFilesCount = 0;
  for (const child of sortedFolders) {
    analyzedCount += child.analyzedCount;
    skippedCount += child.skippedCount;
    findingCount += child.findingCount;
    findingsFilesCount += child.findingsFilesCount;
  }
  for (const fileEntry of sortedFiles) {
    if (fileEntry.kind === "analyzed") {
      analyzedCount += 1;
      const count = fileEntry.file.result.maintainability_findings.length;
      findingCount += count;
      if (count > 0) findingsFilesCount += 1;
    } else {
      skippedCount += 1;
    }
  }
  return {
    name: node.name,
    path: node.path,
    folders: sortedFolders,
    files: sortedFiles,
    analyzedCount,
    skippedCount,
    findingCount,
    findingsFilesCount,
  };
}
function buildRepoTree(analyzedFiles, skippedList) {
  const root = createTreeNode("Kök dizin", "");
  for (const file of analyzedFiles || []) {
    insertIntoRepoTree(root, file.path, { kind: "analyzed", file });
  }
  for (const item of skippedList || []) {
    insertIntoRepoTree(root, item.path, { kind: "skipped", skipped: item });
  }
  return finalizeRepoTree(root);
}
function renderMapLegend() {
  const items = [
    ["rule-complex_function", "Karmaşık fonksiyon"],
    ["rule-large_file", "Büyük dosya"],
    ["rule-dense_expressions", "Yoğun ifadeler"],
    ["rule-clean", "Bulgu yok"],
    ["map-skipped-badge", "Atlandı (analiz edilmedi)"],
  ];
  $("map-legend").replaceChildren();
  for (const [cls, label] of items) {
    const badge = document.createElement("span");
    badge.className = `rule-badge ${cls}`;
    badge.textContent = label;
    $("map-legend").append(badge);
  }
}
function renderMapFileEntry(entry) {
  if (entry.kind === "skipped") {
    const box = document.createElement("div");
    box.className = "map-file map-file-skipped";
    const main = document.createElement("div");
    main.className = "map-file-main";
    const name = document.createElement("code");
    name.className = "map-file-name";
    name.textContent = entry.name;
    name.title = entry.path;
    const badge = document.createElement("span");
    badge.className = "rule-badge map-skipped-badge";
    badge.textContent = "Atlandı · Analiz edilmedi";
    main.append(name, badge);
    const meta = document.createElement("div");
    meta.className = "map-file-meta";
    meta.textContent = `Neden: ${reasons[entry.skipped.reason] || entry.skipped.reason}`;
    box.append(main, meta);
    return box;
  }
  const file = entry.file;
  const findings = file.result.maintainability_findings;
  const button = document.createElement("button");
  button.type = "button";
  button.className =
    findings.length > 0
      ? `map-file map-file-findings map-rule-${findings[0].rule}`
      : "map-file map-file-clean";
  button.setAttribute(
    "aria-label",
    `${entry.path}, ${findings.length > 0 ? `${findings.length} bakım bulgusu` : "bulgu yok"}`,
  );
  button.addEventListener("click", () => openFile(file));
  const main = document.createElement("div");
  main.className = "map-file-main";
  const name = document.createElement("code");
  name.className = "map-file-name";
  name.textContent = entry.name;
  name.title = entry.path;
  const badges = document.createElement("div");
  badges.className = "rule-badges";
  if (findings.length === 0) {
    const clean = document.createElement("span");
    clean.className = "rule-badge rule-clean";
    clean.textContent = "Bulgu yok";
    badges.append(clean);
  } else {
    for (const finding of findings) {
      const badge = document.createElement("span");
      badge.className = `rule-badge rule-${finding.rule}`;
      badge.textContent = ruleLabel(finding.rule);
      badges.append(badge);
    }
  }
  main.append(name, badges);
  const meta = document.createElement("div");
  meta.className = "map-file-meta";
  meta.textContent = `LOC: ${file.metrics.loc} · Maks. karmaşıklık: ${file.metrics.cyclomatic_complexity_max}`;
  button.append(main, meta);
  return button;
}
function renderMapFolder(folder, depth, expandAll) {
  const details = document.createElement("details");
  details.className = "map-folder";
  if (expandAll || depth < 2) details.open = true;
  const summary = document.createElement("summary");
  summary.className = "map-folder-summary";
  const titleWrap = document.createElement("span");
  titleWrap.className = "map-folder-name";
  titleWrap.textContent = `📁 ${folder.name}`;
  titleWrap.title = folder.path || folder.name;
  const stats = document.createElement("div");
  stats.className = "map-folder-stats";
  const fileStat = document.createElement("span");
  fileStat.className = "meta-chip";
  fileStat.textContent = `${folder.analyzedCount} dosya`;
  stats.append(fileStat);
  if (folder.skippedCount > 0) {
    const skipStat = document.createElement("span");
    skipStat.className = "meta-chip";
    skipStat.textContent = `${folder.skippedCount} atlandı`;
    stats.append(skipStat);
  }
  if (folder.analyzedCount > 0) {
    const findingStat = document.createElement("span");
    findingStat.className =
      folder.findingCount > 0
        ? "rule-badge rule-complex_function"
        : "rule-badge rule-clean";
    findingStat.textContent =
      folder.findingCount > 0 ? `${folder.findingCount} bulgu` : "Bulgu yok";
    stats.append(findingStat);
  } else {
    const unanalyzedStat = document.createElement("span");
    unanalyzedStat.className = "rule-badge map-skipped-badge";
    unanalyzedStat.textContent = "Analiz edilmedi";
    stats.append(unanalyzedStat);
  }
  summary.append(titleWrap, stats);
  const children = document.createElement("div");
  children.className = "map-folder-children";
  for (const sub of folder.folders) {
    children.append(renderMapFolder(sub, depth + 1, expandAll));
  }
  for (const entry of folder.files) {
    children.append(renderMapFileEntry(entry));
  }
  details.append(summary, children);
  return details;
}
function renderRepoMap(analyzedFiles, skippedList, { expandAll = false } = {}) {
  renderMapLegend();
  const tree = buildRepoTree(analyzedFiles, skippedList);
  const container = $("repo-map-tree");
  container.replaceChildren();
  for (const folder of tree.folders) {
    container.append(renderMapFolder(folder, 0, expandAll));
  }
  for (const entry of tree.files) {
    container.append(renderMapFileEntry(entry));
  }
}
function setFilesView(view) {
  activeView = view === "map" ? "map" : "list";
  $("view-list").setAttribute("aria-selected", String(activeView === "list"));
  $("view-map").setAttribute("aria-selected", String(activeView === "map"));
  $("list-view").hidden = activeView !== "list";
  $("repo-map-view").hidden = activeView !== "map";
  renderFiles();
}
$("view-list").addEventListener("click", () => setFilesView("list"));
$("view-map").addEventListener("click", () => setFilesView("map"));
$("include-skipped-map").addEventListener("change", renderFiles);
$("map-expand-all").addEventListener("click", () => {
  for (const el of $("repo-map-tree").querySelectorAll("details.map-folder")) {
    el.open = true;
  }
});
$("map-collapse-all").addEventListener("click", () => {
  for (const el of $("repo-map-tree").querySelectorAll("details.map-folder")) {
    el.open = false;
  }
});
$("close-dialog").addEventListener("click", () => $("file-dialog").close());
$("file-dialog").addEventListener("click", (event) => {
  if (event.target === $("file-dialog")) $("file-dialog").close();
});
$("search").addEventListener("input", renderFiles);
$("findings-only").addEventListener("change", renderFiles);
$("rule-filter").addEventListener("change", renderFiles);
$("file-sort").addEventListener("change", renderFiles);
$("clear-filters").addEventListener("click", () => {
  $("search").value = "";
  $("findings-only").checked = false;
  $("rule-filter").value = "all";
  $("file-sort").value = "original";
  renderFiles();
});
$("refresh").addEventListener("click", async () => {
  try {
    await refreshHistory();
    if (currentId && !compareMode) await selectJob(currentId);
  } catch (e) {
    showError(e);
  }
});
$("compare-mode-btn").addEventListener("click", () => {
  compareMode = !compareMode;
  if (!compareMode) compareSelection = [];
  updateCompareBar();
  renderHistory(lastJobs);
});
$("clear-compare").addEventListener("click", () => {
  compareMode = false;
  compareSelection = [];
  updateCompareBar();
  renderHistory(lastJobs);
});
$("run-compare").addEventListener("click", () => {
  if (compareSelection.length === 2) {
    openComparison(compareSelection[0], compareSelection[1]);
  }
});
$("compare-close").addEventListener("click", () => {
  $("compare-view").hidden = true;
  if (currentId) selectJob(currentId);
  else $("welcome").hidden = false;
});
$("scan-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("form-error").hidden = true;
  $("start").disabled = true;
  try {
    const repo = $("repo").value.trim();
    if (!repo) throw new Error("Lütfen proje klasörünün tam yolunu gir.");
    const data = await api("/api/scans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo_path: repo,
        max_commits: Number($("commits").value),
        observation_commits: Number($("window").value),
        excludes: $("excludes")
          .value.split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      }),
    });
    await selectJob(data.id);
    await refreshHistory();
  } catch (error) {
    showError(error);
  } finally {
    $("start").disabled = false;
  }
});
(async () => {
  try {
    const jobs = await refreshHistory();
    if (jobs.length) $("repo").value = jobs[0].payload.repo_path;
    const match = location.hash.match(/^#scan=([a-f0-9]{32})$/);
    if (match) await selectJob(match[1]);
  } catch (error) {
    showError(error);
  }
})();
