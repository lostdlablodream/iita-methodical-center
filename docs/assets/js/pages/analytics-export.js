function csvCell(value) {
  const text = String(value ?? "");
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function createSection(name, rows) {
  return [
    `[${name}]`,
    "id;name;count",
    ...rows.map((row) => [csvCell(row.id), csvCell(row.name), csvCell(row.count)].join(";")),
    "",
  ];
}

export function buildAnalyticsCsv(model) {
  if (!model || !Array.isArray(model.institutes) || !Array.isArray(model.topics)
    || !Array.isArray(model.needTags) || !Array.isArray(model.formats)) {
    throw new TypeError("Для экспорта нужны агрегированные данные");
  }

  const lines = [
    `scope;${csvCell(model.scope)}`,
    `filterTopicId;${csvCell(model.topicId ?? "all")}`,
    `generatedAt;${csvCell(model.generatedAt)}`,
    "",
    ...createSection("institutes", model.institutes),
    ...createSection("topics", model.topics),
    ...createSection("needTags", model.needTags),
    ...createSection("formats", model.formats),
  ];
  return `\uFEFF${lines.join("\r\n")}`;
}

export function downloadAnalyticsCsv(model, options = {}) {
  const documentRef = options.document ?? globalThis.document;
  const urlApi = options.urlApi ?? globalThis.URL;
  const BlobImpl = options.Blob ?? globalThis.Blob;
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const csv = buildAnalyticsCsv(model);
  const blob = new BlobImpl([csv], { type: "text/csv;charset=utf-8" });
  const url = urlApi.createObjectURL(blob);
  const topicPart = String(model.topicId ?? "all").replace(/[^a-z0-9_-]+/gi, "-");
  const datePart = /^\d{4}-\d{2}-\d{2}/.test(model.generatedAt)
    ? model.generatedAt.slice(0, 10)
    : "aggregates";
  const filename = `methodical-analytics-${topicPart}-${datePart}.csv`;
  const anchor = documentRef.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;

  try {
    documentRef.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    schedule(() => urlApi.revokeObjectURL(url), 0);
  }

  return { csv, filename };
}
