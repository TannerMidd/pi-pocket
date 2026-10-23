# Where the fonts come from

Each font is from its project's own release (or, for JetBrains Mono's italic, its repository at a fixed commit), checked
against the digest GitHub or npm publishes where there is one, and kept with its license. Nothing is fetched from another
site when the app runs: the page's security policy allows fonts only from the app itself.

`JetBrainsMono.woff2`, `OFL.txt`, `Geist.woff2`, and `Geist-OFL.txt` are the app's own fonts and are not covered here.

## Whole files, as released

| File                                | From                                                                                                                                                                                                                       |  Bytes |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: |
| `FiraCode-VF.woff2`                 | [Fira Code 6.2](https://github.com/tonsky/FiraCode/releases/tag/6.2), `Fira_Code_v6.2.zip`: `woff2/FiraCode-VF.woff2`                                                                                                      | 113088 |
| `IBMPlexMono-Variable.woff2`        | [IBM Plex Mono variable 1.0.0](https://github.com/IBM/plex/releases/tag/%40ibm%2Fplex-mono-variable%401.0.0), `plex-mono-variable.zip`: `fonts/complete/woff2/IBM Plex Mono Var-Roman.woff2`                               |  83488 |
| `IBMPlexMono-Variable-Italic.woff2` | the same archive: `fonts/complete/woff2/IBM Plex Mono Var-Italic.woff2`                                                                                                                                                    |  96788 |
| `InterVariable.woff2`               | [Inter 4.1](https://github.com/rsms/inter/releases/tag/v4.1), `Inter-4.1.zip`: `web/InterVariable.woff2`                                                                                                                   | 352240 |
| `InterVariable-Italic.woff2`        | the same archive: `web/InterVariable-Italic.woff2`                                                                                                                                                                         | 387976 |
| `JetBrainsMono-Italic.woff2`        | [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) at commit `19371302b95d218af43299bce79ddbddd0bc364d`: `fonts/webfonts/JetBrainsMono-Italic[wght].woff2` (git blob `5e8a82e3669297716702f70a5f9ca242ca050896`) | 123160 |

`plex-mono-variable.zip` matched GitHub's SHA-256 digest
(`46bbde4aeab959180ebad197f5b841c6bb5c8070146ba02c31240556e1e0b40d`). The Fira Code and Inter archives have no published
digest; their members were read with their CRC-32 checked.

## Cut down

These two are cut down, so the browser downloads less. The SIL Open Font License lets a changed font keep its name
unless the license reserves it: Iosevka's license reserves none, and the Nerd Fonts symbols are under MIT and the licenses
of their icon sets. Both keep every name record of the original.

- **Iosevka** (`Iosevka-{Regular,SemiBold,Bold,Italic,SemiBoldItalic,BoldItalic}.woff2`): from
  [Iosevka 34.9.0](https://github.com/be5invis/Iosevka/releases/tag/v34.9.0), `PkgWebFont-Unhinted-Iosevka-34.9.0.zip`
  (SHA-256 `06dcbcf3ea7f2ca34281ac5026eafffffcc3960641e1ea74c56b0a372846cc63`), `WOFF2-Unhinted/Iosevka-<weight>.woff2`.
  Every character stays; only the optional letter variants (the `ss` and `cv` features, which the app never turns on)
  are dropped, which were three quarters of each file. With fontTools:

    ```python
    options = subset.Options()
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_outline = True
    options.flavor = "woff2"
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=font.getBestCmap().keys())
    subsetter.subset(font)
    ```

- **Nerd Fonts symbols** (`NerdFontsSymbolsMono.woff2`): from
  [Nerd Fonts 3.5.1](https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1), `NerdFontsSymbolsOnly.tar.xz`
  (SHA-256 `01172f37db8543edb102e5cb5c64101c9f4686630804d49b419aa07b23a69996`), `SymbolsNerdFontMono-Regular.ttf`: the
  Mono build, each icon one cell wide. Cut to the private use areas its icons fill (`U+E000-F8FF`, `U+F0000-F1AF0`, as
  its `@font-face` says) and saved as WOFF2. `NerdFonts-LICENSE.txt` and `NerdFonts-README.txt` are the release's.

## SHA-256 of each file here

```text
408e876a202f15ea6ee307a70a65cf40ceb222c589a0b17e0a3a371db96dd49f  FiraCode-VF.woff2
b1c1137b5de255336110167a3a66531bed1e7d14fc8a0a384bd0d7c06bdd433b  IBMPlexMono-Variable-Italic.woff2
ef55d69e81baa6523a9b6e015d746e707bc7e9579f18703a169cb18c36dd567b  IBMPlexMono-Variable.woff2
e564f652916db6c139570fefb9524a77c4d48f30c92928de9db19b6b5c7a262a  InterVariable-Italic.woff2
693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3  InterVariable.woff2
43044061a40578d1e7b6d22c75798de0b85de5cfec3f8fd93208be445eb613b3  Iosevka-BoldItalic.woff2
4456f039689dff41e712108d32cff333c1d87fb96fb093a6ef02c895fdd0f111  Iosevka-Bold.woff2
6da879a8418c4468e4d40c7c59b4e37d60be5cd64276574355873b1d92c14e73  Iosevka-Italic.woff2
187a01ab6b2fb44d1b3cff768c079daa48ecba49f8a32ead8499b7333414f751  Iosevka-Regular.woff2
1771884aa8087711bf423eda72136ed1ac0fc1589479873c8cbd38bf994dcd17  Iosevka-SemiBoldItalic.woff2
baa2e7851f9cdc14ce6df543e4a61b94f81a8a418b3824e86580073884fc8152  Iosevka-SemiBold.woff2
76a805b6ea613ce2e3973f1bac6fa29db23116b2881390b59247d22890844ecc  JetBrainsMono-Italic.woff2
6874ea10824785e9e6fd88a6dae5cfb663945dd09e151c3c2e329064d89d9752  NerdFontsSymbolsMono.woff2
```
