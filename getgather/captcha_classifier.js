(() => {
  try {
    const has = (sel) => {
      try {
        return !!document.querySelector(sel);
      } catch (e) {
        return false;
      }
    };
    const srcs = [];
    document.querySelectorAll("script[src], iframe[src], link[href]").forEach((el) => {
      const v = el.getAttribute("src") || el.getAttribute("href") || "";
      if (v) srcs.push(v);
    });
    let html = "";
    try {
      html = document.documentElement.outerHTML;
    } catch (e) {}
    const hay = (srcs.join(" ") + " " + html).toLowerCase();

    if (
      hay.includes("awswaf.com") ||
      hay.includes("awswafintegration") ||
      hay.includes("awswafcaptcha")
    )
      return "aws_waf";
    if (
      hay.includes("arkoselabs.com") ||
      hay.includes("funcaptcha.com") ||
      has("iframe[title='verification puzzle']") ||
      has("#cvf-aamation-challenge-iframe")
    )
      return "arkose_funcaptcha";
    if (hay.includes("hcaptcha.com") || has(".h-captcha") || has('iframe[src*="hcaptcha"]'))
      return "hcaptcha";
    if (hay.includes("recaptcha/enterprise")) return "recaptcha_enterprise";
    if (/recaptcha\/api\.js\?[^\s"']*render=/.test(hay)) return "recaptcha_v3";
    if (
      hay.includes("recaptcha/api2") ||
      has(".g-recaptcha") ||
      has('iframe[src*="recaptcha"]') ||
      hay.includes("google.com/recaptcha")
    )
      return "recaptcha_v2";
    if (
      hay.includes("challenges.cloudflare.com") ||
      has(".cf-turnstile") ||
      hay.includes("__cf_chl") ||
      hay.includes("cf-challenge") ||
      hay.includes("turnstile")
    )
      return "cloudflare";
    if (hay.includes("geetest") || has('[class^="geetest_"]')) return "geetest";
    if (hay.includes("mtcaptcha")) return "mtcaptcha";
    if (has("#captchacharacters") || has('img[src*="captcha"]')) return "image_ocr";
    if (has("#px-captcha") || has(".px-captcha-header") || has('[id^="px-captcha"]'))
      return "perimeterx";
    return "unknown";
  } catch (e) {
    return "unknown";
  }
})();
