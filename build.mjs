import fs from 'fs';
import * as esbuild from 'esbuild';

async function build() {
  console.log('Building the 3dots Travel office bundle…');
  const result = await esbuild.build({
    entryPoints: ['src/main.js'],
    bundle: true,
    write: false,
    format: 'iife',
    minify: true,
  });

  const bundledJs = result.outputFiles[0].text;
  const shell = fs.readFileSync('src/shell.html', 'utf8');
  // The replacement MUST be a function. Passed as a plain string, String.replace expands `$&`,
  // `$'` and `` $` `` inside the replacement — and minified JavaScript contains `$&` routinely, so
  // the literal marker text gets injected into the middle of the bundle and the page dies with a
  // syntax error. A function replacer is taken literally.
  const finalHtml = shell.replace('<!--APP-->', () => `<script>\n${bundledJs}\n</script>`);
  fs.writeFileSync('public/index.html', finalHtml, 'utf8');
  console.log('✅ Successfully compiled and written to public/index.html');
}

build().catch(err => {
  console.error('❌ Build error:', err);
  process.exit(1);
});

