# bbox_labeler.py — improved progress, reliability, and UX
#
# Usage examples:
#   python bbox_labeler.py --images-root output/products --autosave --resume --unlabeled-only
#   python bbox_labeler.py --images-root output/products/product-41563-richardson-112-trucker-snapback-cap --autosave
#
# Requires: matplotlib, pillow
#   pip install matplotlib pillow
#
# Notes:
# - Saves to output/logos.json (and timestamped backups in output/)
# - Session state persists to output/labeler_state.json (resume with --resume)
# - Status glyphs per image:
#     ✓ labeled (saved)   • unsaved changes   – skipped   ○ unlabeled

import argparse
import json
import os
import sys
import glob
import time
import datetime
from typing import List, Dict, Tuple, Optional
from PIL import Image

import matplotlib
# Change to "Qt5Agg" if you prefer Qt (pip install PyQt5)
matplotlib.use("TkAgg")
import matplotlib.pyplot as plt
from matplotlib.widgets import RectangleSelector, Button, TextBox, CheckButtons

DEFAULT_JSON = "output/logos.json"
STATE_JSON   = "output/labeler_state.json"

HELP_TEXT = """Shortcuts:
  Enter: Add Box  |  U: Undo  |  C: Clear image boxes
  N: Next         |  P: Prev  |  G: Next unlabeled   |  K: Skip
  S: Save         |  H: Help  |  Q: Quit

Tips:
  - Autosave ON is recommended (toggle bottom-right).
  - Status glyphs: ✓ saved, • unsaved changes, – skipped, ○ unlabeled.
  - The green status line shows overall dataset coverage.
"""

# ---------- Utilities ----------

def list_images(root: str) -> List[str]:
    exts = (".jpg", ".jpeg", ".png", ".webp")
    paths = []
    if os.path.isdir(root):
        for dirpath, _, files in os.walk(root):
            for fn in files:
                if fn.lower().endswith(exts):
                    paths.append(os.path.join(dirpath, fn))
    else:
        if root.lower().endswith(exts):
            paths = [root]
    # Deduplicate + stable sort
    paths = sorted(set(paths), key=lambda p: p)
    return paths

def load_json(path: str) -> Dict:
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            try:
                return json.load(f)
            except Exception:
                pass
    return {}

def save_with_backup(path: str, data: Dict):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # backup
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = os.path.join(os.path.dirname(path), f"logos.backup-{ts}.json")
    try:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as fsrc, open(backup, "w", encoding="utf-8") as fdst:
                fdst.write(fsrc.read())
    except Exception:
        pass
    # save
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4)

def load_state() -> Dict:
    if os.path.exists(STATE_JSON):
        try:
            with open(STATE_JSON, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_state(state: Dict):
    os.makedirs(os.path.dirname(STATE_JSON), exist_ok=True)
    with open(STATE_JSON, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)

def filename_only(p: str) -> str:
    return os.path.basename(p)

# ---------- App ----------

class Labeler:
    def __init__(self, images: List[str], logos_json_path: str, autosave: bool, resume: bool, unlabeled_only: bool):
        if not images:
            print("No images found.", file=sys.stderr)
            sys.exit(1)

        self.images_full = images[:]  # full list for global progress
        self.json_path = logos_json_path
        self.data = load_json(self.json_path)
        self.autosave_flag = autosave
        self.unlabeled_only = unlabeled_only

        # Session / progress state
        st = load_state() if resume else {}
        self.skipped = set(st.get("skipped", []))
        self.idx = int(st.get("current_index", 0)) if resume else 0

        # Build working list depending on unlabeled_only
        if unlabeled_only:
            self.images = [p for p in images if (filename_only(p) not in self.data and filename_only(p) not in self.skipped)]
            if self.idx >= len(self.images):
                self.idx = max(0, len(self.images) - 1)
        else:
            self.images = images

        # Matplotlib figure layout
        self.fig, self.ax = plt.subplots(figsize=(12, 9))
        plt.subplots_adjust(left=0.06, right=0.94, top=0.90, bottom=0.18)

        # Widgets: bottom controls
        axname = plt.axes([0.06, 0.08, 0.32, 0.055])
        self.textbox = TextBox(axname, "Box name:", initial="logo_area")

        ax_add  = plt.axes([0.39, 0.08, 0.09, 0.055]); self.btn_add  = Button(ax_add,  "Add Box (Enter)")
        ax_undo = plt.axes([0.49, 0.08, 0.08, 0.055]); self.btn_undo = Button(ax_undo, "Undo (U)")
        ax_clear= plt.axes([0.58, 0.08, 0.08, 0.055]); self.btn_clear= Button(ax_clear,"Clear (C)")
        ax_save = plt.axes([0.67, 0.08, 0.08, 0.055]); self.btn_save = Button(ax_save, "Save (S)")

        ax_prev = plt.axes([0.06, 0.015, 0.10, 0.05]); self.btn_prev  = Button(ax_prev,  "Prev (P)")
        ax_next = plt.axes([0.17, 0.015, 0.10, 0.05]); self.btn_next  = Button(ax_next,  "Next (N)")
        ax_nextu= plt.axes([0.28, 0.015, 0.16, 0.05]); self.btn_nextu = Button(ax_nextu, "Next Unlabeled (G)")
        ax_skip = plt.axes([0.45, 0.015, 0.10, 0.05]); self.btn_skip  = Button(ax_skip,  "Skip (K)")
        ax_help = plt.axes([0.56, 0.015, 0.08, 0.05]); self.btn_help  = Button(ax_help,  "Help (H)")
        ax_auto = plt.axes([0.66, 0.015, 0.16, 0.05]); self.chk_auto  = CheckButtons(ax_auto, ["Autosave"], [self.autosave_flag])

        # Status text (top)
        self.title_text  = self.fig.text(0.5, 0.96, "", ha="center", va="center", fontsize=13, fontweight="bold")
        self.status_text = self.fig.text(0.5, 0.93, "", ha="center", va="center", fontsize=10, color="#006400")
        self.help_text   = None
        self.last_saved_ts = None
        self.dirty = False

        # Rectangle selector & overlays
        self.selector = RectangleSelector(
            self.ax, self.on_select, useblit=True,
            button=[1],  # left mouse
            interactive=True, minspanx=2, minspany=2,
            spancoords='pixels'
        )
        self.current_rect = None  # (x1,y1,x2,y2)
        self.temp_artist = None
        self.boxes_for_image = []  # [{'name', 'x1','y1','x2','y2'}]
        self.drawn_artists = []    # rectangles already drawn

        # Wire up actions
        self.btn_add.on_clicked(self.add_box)
        self.btn_undo.on_clicked(self.undo_box)
        self.btn_clear.on_clicked(self.clear_boxes)
        self.btn_save.on_clicked(self.save_json)
        self.btn_prev.on_clicked(self.prev_img)
        self.btn_next.on_clicked(self.next_img)
        self.btn_nextu.on_clicked(self.next_unlabeled)
        self.btn_skip.on_clicked(self.skip_image)
        self.btn_help.on_clicked(self.toggle_help)
        self.chk_auto.on_clicked(self.toggle_autosave)
        self.fig.canvas.mpl_connect('key_press_event', self.on_key)

        self.load_image()
        self.refresh_status()

    # ---------- Helpers ----------

    def total(self) -> int:
        return len(self.images)

    def image_key(self) -> str:
        return filename_only(self.images[self.idx])

    def image_status_glyph(self, fn: str) -> str:
        if fn in self.skipped:
            return "–"
        if fn in self.data:
            return "•" if self.dirty else "✓"
        return "•" if self.dirty else "○"

    def progress_counts(self) -> Tuple[int,int,int,int]:
        total = len(self.images_full)
        labeled = sum(1 for p in self.images_full if filename_only(p) in self.data)
        skipped = sum(1 for p in self.images_full if filename_only(p) in self.skipped)
        done = labeled + skipped
        return total, labeled, skipped, done

    def refresh_status(self, msg: Optional[str]=None, good: bool=True):
        # Top title with per-image status
        fn = self.image_key()
        glyph = self.image_status_glyph(fn)
        title = f"{self.idx+1}/{self.total()} {glyph} — {fn}"
        self.title_text.set_text(title)

        # Green status (or red if error) with global progress
        total, labeled, skipped, done = self.progress_counts()
        percent = (100.0 * done / total) if total else 0.0
        pmsg = f"Progress: {done}/{total} ({percent:.1f}%)  |  Labeled: {labeled}  Skipped: {skipped}  Unlabeled: {total-done}"
        if msg:
            pmsg = f"{msg}    |    {pmsg}"

        self.status_text.set_text(pmsg)
        self.status_text.set_color("#006400" if good else "#8B0000")
        self.fig.canvas.draw_idle()

    def toggle_autosave(self, _event=None):
        self.autosave_flag = not self.autosave_flag
        self.refresh_status(f"Autosave {'ON' if self.autosave_flag else 'OFF'}")

    # ---------- Image & drawing ----------

    def load_image(self):
        self.ax.clear()
        path = self.images[self.idx]
        im = Image.open(path)
        self.ax.imshow(im, origin='upper')
        self.ax.set_title(os.path.relpath(path), fontsize=11)
        self.ax.axis('off')
        # Load existing boxes
        self.boxes_for_image = list(self.data.get(self.image_key(), {}).get("boxes", []))
        # Draw them
        self.drawn_artists = []
        for i, b in enumerate(self.boxes_for_image, start=1):
            self.draw_box_artist(b, label=str(i))
        # Reset temp
        if self.temp_artist:
            try:
                self.temp_artist.remove()
            except Exception:
                pass
            self.temp_artist = None
        self.current_rect = None
        self.dirty = False
        self.fig.canvas.draw_idle()

    def draw_box_artist(self, b: Dict, label: Optional[str]=None):
        x1,y1,x2,y2 = b["x1"], b["y1"], b["x2"], b["y2"]
        rect = plt.Rectangle((x1, y1), x2-x1, y2-y1, fill=False, linewidth=2)
        self.ax.add_patch(rect)
        self.drawn_artists.append(rect)
        if label:
            txt = self.ax.text(
                x1+6, max(0, y1-8),
                f"{label}:{b.get('name','logo_area')}",
                fontsize=9, color='black',
                bbox=dict(facecolor='white', alpha=0.6, edgecolor='none', pad=1.5)
            )
            self.drawn_artists.append(txt)

    def on_select(self, eclick, erelease):
        if eclick.xdata is None or erelease.xdata is None:
            return
        x1, y1 = int(round(eclick.xdata)), int(round(eclick.ydata))
        x2, y2 = int(round(erelease.xdata)), int(round(erelease.ydata))
        x1, x2 = sorted([x1, x2])
        y1, y2 = sorted([y1, y2])
        self.current_rect = (x1, y1, x2, y2)
        if self.temp_artist:
            try:
                self.temp_artist.remove()
            except Exception:
                pass
            self.temp_artist = None
        self.temp_artist = self.ax.add_patch(
            plt.Rectangle((x1, y1), x2-x1, y2-y1, fill=False, linewidth=2, linestyle='--')
        )
        self.fig.canvas.draw_idle()

    # ---------- Actions ----------

    def add_box(self, _event=None):
        if not self.current_rect:
            self.refresh_status("Draw a rectangle first.", good=False)
            return
        name = self.textbox.text.strip() or "logo_area"
        x1,y1,x2,y2 = self.current_rect
        entry = {"name": name, "x1": x1, "y1": y1, "x2": x2, "y2": y2}

        # persist in-memory
        fn = self.image_key()
        self.data.setdefault(fn, {"boxes": []})
        self.data[fn]["boxes"].append(entry)
        self.boxes_for_image.append(entry)

        # draw permanent
        self.draw_box_artist(entry, label=str(len(self.boxes_for_image)))

        # clear temp
        if self.temp_artist:
            try:
                self.temp_artist.remove()
            except Exception:
                pass
            self.temp_artist = None
        self.current_rect = None
        self.dirty = True

        if self.autosave_flag:
            self.save_json()
        else:
            self.refresh_status("Box added (not yet saved).", good=True)

    def undo_box(self, _event=None):
        if not self.boxes_for_image:
            self.refresh_status("Nothing to undo.", good=False)
            return
        self.boxes_for_image.pop()
        fn = self.image_key()
        if fn in self.data and self.data[fn].get("boxes"):
            self.data[fn]["boxes"].pop()
            if not self.data[fn]["boxes"]:
                del self.data[fn]
        # redraw
        for art in self.drawn_artists:
            try:
                art.remove()
            except Exception:
                pass
        self.drawn_artists = []
        for i, b in enumerate(self.boxes_for_image, start=1):
            self.draw_box_artist(b, label=str(i))
        self.fig.canvas.draw_idle()
        self.dirty = True
        if self.autosave_flag:
            self.save_json()
        else:
            self.refresh_status("Undo done (not yet saved).", good=True)

    def clear_boxes(self, _event=None):
        fn = self.image_key()
        if fn in self.data:
            del self.data[fn]
        self.boxes_for_image = []
        for art in self.drawn_artists:
            try:
                art.remove()
            except Exception:
                pass
        self.drawn_artists = []
        self.fig.canvas.draw_idle()
        self.dirty = True
        if self.autosave_flag:
            self.save_json()
        else:
            self.refresh_status("Cleared boxes (not yet saved).", good=True)

    def skip_image(self, _event=None):
        fn = self.image_key()
        self.skipped.add(fn)
        self.save_session_state()
        self.refresh_status("Image skipped.", good=True)
        self.next_img()

    def next_img(self, _event=None):
        if self.dirty and self.autosave_flag:
            self.save_json()
        if self.idx < self.total() - 1:
            self.idx += 1
            self.load_image()
            self.save_session_state()
            self.refresh_status()
        else:
            self.refresh_status("Reached last image.", good=True)

    def prev_img(self, _event=None):
        if self.dirty and self.autosave_flag:
            self.save_json()
        if self.idx > 0:
            self.idx -= 1
            self.load_image()
            self.save_session_state()
            self.refresh_status()
        else:
            self.refresh_status("At first image.", good=True)

    def next_unlabeled(self, _event=None):
        start = self.idx + 1
        for i in range(start, self.total()):
            fn = filename_only(self.images[i])
            if fn not in self.data and fn not in self.skipped:
                self.idx = i
                self.load_image()
                self.save_session_state()
                self.refresh_status("Jumped to next unlabeled.")
                return
        self.refresh_status("No more unlabeled images.", good=True)

    def save_json(self, _event=None):
        try:
            save_with_backup(self.json_path, self.data)
            self.last_saved_ts = time.strftime("%H:%M:%S")
            self.dirty = False
            self.save_session_state()
            self.refresh_status(f"Saved at {self.last_saved_ts} ✓", good=True)
        except Exception as e:
            self.refresh_status(f"Save failed: {e}", good=False)

    def save_session_state(self):
        # Save resume info based on the *full* list
        state = load_state()
        state["current_index"] = self.idx if not self.unlabeled_only else 0  # keep 0 for filtered runs
        state["skipped"] = sorted(set(list(state.get("skipped", [])) + list(self.skipped)))
        state["images_snapshot"] = [filename_only(p) for p in self.images_full]
        save_state(state)

    # ---------- Keyboard ----------

    def on_key(self, event):
        k = (event.key or "").lower()
        if k in ["enter", "return"]:
            self.add_box(); return
        if k == "n":
            self.next_img(); return
        if k == "p":
            self.prev_img(); return
        if k == "g":
            self.next_unlabeled(); return
        if k == "u":
            self.undo_box(); return
        if k == "c":
            self.clear_boxes(); return
        if k == "s":
            self.save_json(); return
        if k == "k":
            self.skip_image(); return
        if k == "h":
            self.toggle_help(); return
        if k == "q":
            plt.close(self.fig); return

    def toggle_help(self, _event=None):
        if self.help_text and self.help_text.get_visible():
            self.help_text.set_visible(False)
        else:
            if self.help_text is None:
                self.help_text = self.fig.text(
                    0.02, 0.60, HELP_TEXT, fontsize=10, va="top",
                    bbox=dict(facecolor="white", alpha=0.85, edgecolor="#999")
                )
            else:
                self.help_text.set_text(HELP_TEXT)
                self.help_text.set_visible(True)
        self.fig.canvas.draw_idle()

# ---------- CLI ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--images-root", required=True, help="Folder with images (a product folder or products root)")
    ap.add_argument("--logos-json", default=DEFAULT_JSON, help=f"Path to logos JSON (default: {DEFAULT_JSON})")
    ap.add_argument("--autosave", action="store_true", help="Save automatically after each Add/Undo/Clear")
    ap.add_argument("--resume", action="store_true", help=f"Resume from {STATE_JSON} (current index & skipped)")
    ap.add_argument("--unlabeled-only", action="store_true", help="Only iterate images without boxes or skip marks")
    args = ap.parse_args()

    imgs = list_images(args.images_root)
    if not imgs:
        print("No images found under:", args.images_root, file=sys.stderr)
        sys.exit(1)

    app = Labeler(
        imgs,
        args.logos_json,
        autosave=args.autosave,
        resume=args.resume,
        unlabeled_only=args.unlabeled_only
    )
    plt.show()

if __name__ == "__main__":
    main()
