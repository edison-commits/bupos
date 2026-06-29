/**
 * Basic Uniform — Landing page Worker
 * Serves the public-facing storefront for basicuniform.com
 */

const worker = {
  async fetch(request) {
    const url = new URL(request.url);

    // Redirect www to root
    if (url.hostname === "www.basicuniform.com") {
      url.hostname = "basicuniform.com";
      return Response.redirect(url.toString(), 301);
    }

    return new Response(HTML, {
      headers: {
        "content-type": "text/html;charset=UTF-8",
        "cache-control": "public, max-age=3600",
      },
    });
  },
};

export default worker;

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Basic Uniform — Coming Soon</title>
  <meta name="description" content="Basic Uniform — workwear, uniforms, and casualwear. Coming soon." />
  <meta property="og:title" content="Basic Uniform — Coming Soon" />
  <meta property="og:description" content="Workwear & uniforms for every job. Online store coming soon." />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://basicuniform.com" />
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u{1F454}</text></svg>" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --teal-400: #2dd4bf;
      --teal-500: #14b8a6;
      --teal-600: #0d9488;
      --teal-700: #0f766e;
      --zinc-50: #fafafa;
      --zinc-200: #e4e4e7;
      --zinc-300: #d4d4d8;
      --zinc-400: #a1a1aa;
      --zinc-500: #71717a;
      --zinc-600: #52525b;
      --zinc-800: #27272a;
      --zinc-900: #18181b;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: var(--zinc-900);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* Hero */
    .hero {
      background: var(--zinc-900);
      color: white;
      text-align: center;
      padding: 8rem 1.5rem 6rem;
      position: relative;
      overflow: hidden;
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .hero::before {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(135deg, rgba(13,148,136,0.2), rgba(24,24,27,0.9));
    }
    .hero > * { position: relative; }
    .hero h1 {
      font-size: clamp(2.5rem, 7vw, 4rem);
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .hero-tagline {
      font-size: 1.15rem;
      color: var(--zinc-300);
      margin-top: 1rem;
      max-width: 28rem;
    }
    .coming-soon {
      display: inline-block;
      margin-top: 2.5rem;
      padding: 0.6rem 2rem;
      border: 1px solid var(--teal-600);
      border-radius: 999px;
      font-size: 0.8rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.2em;
      color: var(--teal-400);
    }

    /* Brands */
    .brands {
      background: var(--zinc-50);
      text-align: center;
      padding: 4rem 1.5rem;
    }
    .brands-label {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.2em;
      color: var(--zinc-500);
    }
    .brands-list {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 1.5rem 2.5rem;
      margin-top: 2rem;
      max-width: 48rem;
      margin-left: auto;
      margin-right: auto;
    }
    .brands-list span {
      font-size: clamp(1rem, 2vw, 1.25rem);
      font-weight: 700;
      color: var(--zinc-400);
      letter-spacing: -0.01em;
    }

    /* Footer */
    footer {
      background: var(--zinc-900);
      color: var(--zinc-500);
      text-align: center;
      padding: 2rem 1.5rem;
    }
    footer p {
      font-size: 0.75rem;
    }
  </style>
</head>
<body>

  <header class="hero">
    <h1>Basic Uniform</h1>
    <p class="hero-tagline">Workwear &amp; uniforms for every job.</p>
    <span class="coming-soon">Coming Soon</span>
  </header>

  <section class="brands">
    <p class="brands-label">Brands we carry</p>
    <div class="brands-list">
      <span>Dickies</span>
      <span>Carhartt</span>
      <span>New Era</span>
      <span>JanSport</span>
      <span>Pro Club</span>
      <span>Shaka</span>
      <span>Streetwise</span>
      <span>Ben Davis</span>
      <span>FB County</span>
      <span>WonderWink</span>
    </div>
  </section>

  <footer>
    <p>&copy; 2026 Basic Uniform. All rights reserved.</p>
  </footer>

</body>
</html>`;
