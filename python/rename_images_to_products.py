#!/usr/bin/env python3
"""
Rename images in Stripe-Invoice/public/images/products to match the
imageFile names declared in Stripe-Invoice/public/products.txt

Improved matching rules:
- Normalize names to lowercase alnum
- Remove placement tokens from comparison (right_chest, big_back, full_front)
- Score candidates by common prefix length and placement alignment (front/back)
- Prefer shortest original name when scores tie
"""

import os
import re
import sys
from typing import Dict, List, Tuple

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
PUBLIC_DIR = os.path.join(REPO_ROOT, 'public')
PRODUCTS_TXT = os.path.join(PUBLIC_DIR, 'products.txt')
IMAGES_DIR = os.path.join(PUBLIC_DIR, 'images', 'products')

IMAGE_REGEX = re.compile(r"imageFile\s*:\s*'([^']+)'")
PLACEMENT_TOKENS = ["rightchest", "bigback", "fullfront"]


def normalize_root(name: str) -> str:
	base = os.path.basename(name)
	root, _ = os.path.splitext(base)
	norm = re.sub(r"[^a-z0-9]", "", root.lower())
	for token in PLACEMENT_TOKENS:
		norm = norm.replace(token, "")
	return norm


def parse_target_flags(name: str) -> Tuple[bool, bool, bool]:
	lower = name.lower()
	return (
		"right_chest" in lower,
		"big_back" in lower,
		"full_front" in lower,
	)


def common_prefix_len(a: str, b: str) -> int:
	m = min(len(a), len(b))
	for i in range(m):
		if a[i] != b[i]:
			return i
	return m


def load_target_image_names(products_txt_path: str) -> List[str]:
	with open(products_txt_path, 'r', encoding='utf-8') as f:
		content = f.read()
	targets = IMAGE_REGEX.findall(content)
	seen = set()
	ordered = []
	for t in targets:
		if t not in seen:
			seen.add(t)
			ordered.append(t)
	return ordered


def scan_existing_images(images_dir: str) -> List[str]:
	if not os.path.isdir(images_dir):
		raise FileNotFoundError(f"Images directory not found: {images_dir}")
	return [n for n in os.listdir(images_dir) if os.path.isfile(os.path.join(images_dir, n))]


def score_candidate(target_name: str, target_norm: str, cand_name: str) -> int:
	cand_norm = normalize_root(cand_name)
	base = common_prefix_len(target_norm, cand_norm)
	# Placement bonuses
	t_right, t_back, t_full = parse_target_flags(target_name)
	l = cand_name.lower()
	bonus = 0
	if t_back and ("back" in l):
		bonus += 6
	if (t_right or t_full) and ("front" in l):
		bonus += 4
	# small penalty if mismatched explicit back/front
	if t_back and ("front" in l):
		bonus -= 2
	if (t_right or t_full) and ("back" in l):
		bonus -= 2
	return base * 10 + bonus  # weight prefix more than placement


def main():
	print(f"Images dir: {IMAGES_DIR}")
	print(f"Products file: {PRODUCTS_TXT}")
	if not os.path.exists(PRODUCTS_TXT):
		print("❌ products.txt not found")
		sys.exit(1)
	
	targets = load_target_image_names(PRODUCTS_TXT)
	if not targets:
		print("❌ No imageFile entries found in products.txt")
		sys.exit(1)
	print(f"Found {len(targets)} target image names from products.txt")
	
	existing = scan_existing_images(IMAGES_DIR)
	print(f"Found {len(existing)} existing files in images/products")
	
	# Precompute normalized for existing
	existing_info = [(name, normalize_root(name)) for name in existing]
	
	renamed = []
	skipped = []
	not_found = []
	conflicts = []
	
	for target in targets:
		target_path = os.path.join(IMAGES_DIR, target)
		if os.path.exists(target_path):
			skipped.append((target, 'already present'))
			continue
		
		t_norm = normalize_root(target)
		# Find best scored candidate
		best = None
		best_score = -1
		for cand_name, _ in existing_info:
			s = score_candidate(target, t_norm, cand_name)
			if s > best_score:
				best = cand_name
				best_score = s
		
		# Accept only if decent base overlap
		if best is None:
			not_found.append(target)
			continue
		
		base_overlap = common_prefix_len(t_norm, normalize_root(best))
		min_required = min(len(t_norm) // 2, 10)
		if base_overlap < min_required:
			not_found.append(target)
			continue
		
		src_path = os.path.join(IMAGES_DIR, best)
		try:
			os.replace(src_path, target_path)
			renamed.append((best, target))
		except Exception as e:
			conflicts.append((best, f"{target} ({e})"))
			continue
		
		# Update existing_info list to avoid reusing the same file again
		existing_info = [(n, nn) for (n, nn) in existing_info if n != best]
	
	print("\n==== Rename Report ====")
	for src, dst in renamed:
		print(f"✅ {src} -> {dst}")
	if skipped:
		print("\nSkipped:")
		for tgt, why in skipped:
			print(f"- {tgt}: {why}")
	if not_found:
		print("\nNo suitable source found:")
		for tgt in not_found:
			print(f"- {tgt}")
	if conflicts:
		print("\nConflicts/Errors:")
		for src, info in conflicts:
			print(f"- {src} -> {info}")
	print("\nDone.")

if __name__ == '__main__':
	main() 