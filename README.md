# gallery

**Photo albums on your [Solid](https://solidproject.org) pod.** The standalone,
full-screen sibling of [`hub`](https://github.com/solid-apps/hub)'s Photos pane —
browse albums, view in a lightbox, upload, and share. New shots from
[`camera`](https://github.com/solid-apps/camera) land in these same albums.

## Data model — the suite's established convention

gallery invents nothing; it reads and writes the same shape hub/pilot discover:

- An **album** is an LDP container of image resources, e.g. `/public/photo/<slug>/`.
- Each album is registered in your **TypeIndex** as a `schema:ImageGallery`
  (`solid:instanceContainer`), so hub, camera, and gallery all find it.
- **Public** albums → `/public/photo/` + `solid:publicTypeIndex` (default).
  **Private** albums → `/private/photo/` + `solid:privateTypeIndex`.

Accepted image classes (any pod variant): `schema:ImageGallery`,
`schema:Photograph`, `schema:Photo`, `schema:ImageObject`, `foaf:Image`. Vocab:
`https://schema.org/`, `http://www.w3.org/ns/solid/terms#`.

## What it does

- **Discover** every registered image gallery (public + private TypeIndex) and
  show them as albums with a cover thumbnail.
- **Browse** an album in a responsive grid; click for a **lightbox** (keyboard
  ←/→/Esc, prev/next).
- **Create albums** — public by default, with a one-tap **private** option
  (`/private/photo/` + private TypeIndex).
- **Upload** via picker or drag-and-drop (`PUT` straight to the pod).
- **Delete** a photo.
- **Share** — hand a photo or whole album to
  [`webacl`](https://github.com/solid-apps/webacl) via the intent bus to set who
  can see it.
- **Open with…** — send a photo to any app (e.g. `timeline`, `messages`,
  `plume`) over the `file` intent.

## Interop

Declares `"handles": ["file"]`: other apps can send gallery an image to **save to
an album**, and gallery sends photos out via `file` (open-with) and `url` (to
webacl for permissions).

## Notes / limitations (v1)

- Sign-in is required to discover *your* albums (TypeIndex is read from your
  WebID). Public albums are world-readable by URL once shared.
- Photos shot in [`camera`](https://github.com/solid-apps/camera) come with a
  `<stem>.thumb.jpg` thumbnail; gallery detects it from the album listing (no
  extra requests) and uses it in the grid, falling back to the full image when
  absent. Photos uploaded *into* gallery don't yet get thumbnails generated
  (a planned follow-up) — they lazy-load the full image (`loading="lazy"`),
  which is fine for normal albums and heavier for very large ones.
- "Make existing album private" (physically relocating `/public/` → `/private/`)
  is a follow-up; today, create a private album, or lock any album's ACL via
  **webacl**.

## Run

Static — open `index.html`, or install via the **store** to
`/public/apps/gallery/`.

AGPL-3.0-only.
