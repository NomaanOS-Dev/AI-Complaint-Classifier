export type HelpModalAction = "open" | "close" | "escape";

export function helpModalReducer(isOpen: boolean, action: HelpModalAction) {
  return action === "open";
}

export function escapeHtmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&#39;");
}

export function websiteButtonHtml(url?: string) {
  const href = url
    ? escapeHtmlAttribute(url)
    : "https://YOUR-PUBLIC-NOMAANOS-DOMAIN/contact/YOUR-FORM-TOKEN";
  return `<a
  class="complaint-button"
  href="${href}"
>
  Submit a Complaint
</a>

<style>
  .complaint-button {
    display: inline-block;
    padding: 12px 22px;
    background-color: #2563eb;
    color: white;
    text-decoration: none;
    border-radius: 8px;
    font-family: Arial, sans-serif;
    font-weight: 600;
  }

  .complaint-button:hover {
    background-color: #1d4ed8;
  }
</style>`;
}

export type ClipboardWriter = { writeText: (text: string) => Promise<void> };

export function copyWebsiteButtonCode(url: string | undefined, clipboard: ClipboardWriter) {
  return clipboard.writeText(websiteButtonHtml(url));
}
