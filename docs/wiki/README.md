# Wiki page drafts

These Markdown files are the intended content for the GitHub Wiki pages:

| File | Wiki page |
|------|-----------|
| `Home.md` | Home |
| `Architecture.md` | Architecture |
| `Security.md` | Security |
| `_Sidebar.md` | Wiki sidebar |

## Publishing status

The GitHub Wiki feature is enabled (`has_wiki: true`), but the Wiki Git repository (`MHDLabs/Nyra.wiki`) is not initialized until the first page is created in the GitHub UI. Until then, `git clone` / `git push` to `*.wiki.git` fails with **Repository not found**.

After creating any first page under **Wiki** in the GitHub UI (while signed in with write access), publish these files with:

```bash
git clone https://github.com/MHDLabs/Nyra.wiki.git
# copy the Markdown files from this directory into the clone
git add Home.md Architecture.md Security.md _Sidebar.md
git commit -m "docs(wiki): add Home, Architecture, Security, and sidebar"
git push
```

Keep this folder and the live Wiki content in sync when either side changes.
