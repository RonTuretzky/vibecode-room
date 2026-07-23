## Adding more fonts

The fonts themselves are defined in src/app/fonts.tsx. Once you've added a font there, you then need to add them to globals.css under the `@theme` defintion, and if you want nice combined classes, add those to `@layer components`.

## Compressing fonts

The raw fonts (Space Grotesk and Inter) are not shipped in woff2 format by default (which is a compressed and web optimized format). I've manually compressed and converted the relevant font files. If you need to add any, or adjust the compression, here are the steps.

1. Install python's font tools with `pip install fonttools brotli zopfli`
2. Convert the font using the snippet below:
    ``` bash
    pyftsubset src/fonts/raw/FAMILY/FONT.file \
      --output-file=src/fonts/compressed/FONT-latinExt-puct-curr.woff2 \
      --flavor=woff2 \
      --unicodes="U+0020-007E, U+00A0-00FF, U+2000-206F, U+20A0-20CF" \
      --layout-features='*' \
      --no-hinting \
    ```
    If you find you're missing charachters, you probably need to tweak the unicodes range. I am inluding Latin standard, the extension for normal accents, for extended punctuation, and for a full range of currencies. You can add individual carachters if you know the unicode.
3. Update the `src/app/fonts.tsx` font file definitions
