function rewriteRootRelativeUrls(html, origin) {
  return html
    .replace(/(href|src|action)="\/(?!\/)/g, `$1="${origin}/`)
    .replace(/(href|src|action)='\/(?!\/)/g, `$1='${origin}/`);
}

function stripScripts(html) {
  let out = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  out = out.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  return out;
}

function postProcessHtml(html, pageUrl) {
  const origin = new URL(pageUrl).origin;
  return stripScripts(rewriteRootRelativeUrls(html, origin));
}

module.exports = { rewriteRootRelativeUrls, stripScripts, postProcessHtml };
