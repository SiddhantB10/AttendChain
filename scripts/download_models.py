#!/usr/bin/env python3
"""
AttendChain Model Downloader
Downloads YuNet, SFace, and MediaPipe Face Landmarker models into backend/models/
Includes integrity checks and manual download instructions if network is restricted.
"""

import os
import sys
import urllib.request

MODELS = {
    "face_detection_yunet_2023mar.onnx": {
        "url": "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
        "description": "YuNet Face Detector (OpenCV Zoo)",
        "min_size_bytes": 200_000 # ~230 KB
    },
    "face_recognition_sface_2021dec.onnx": {
        "url": "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
        "description": "SFace 128-d Feature Extractor (OpenCV Zoo)",
        "min_size_bytes": 1_000_000 # ~1.3 MB
    },
    "face_landmarker.task": {
        "url": "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
        "description": "MediaPipe Face Landmarker with Blendshapes",
        "min_size_bytes": 3_500_000 # ~3.76 MB (float16)
    }
}

def download_file(url: str, dest_path: str, description: str, min_size: int):
    print(f"Downloading {description}...")
    print(f"URL: {url}")
    print(f"Destination: {dest_path}")

    try:
        def reporthook(count, block_size, total_size):
            if total_size > 0:
                percent = int(count * block_size * 100 / total_size)
                sys.stdout.write(f"\r  Progress: {percent}% ({count * block_size}/{total_size} bytes)")
                sys.stdout.flush()

        urllib.request.urlretrieve(url, dest_path, reporthook=reporthook)
        print("\n  [PASS] Download complete.")

        actual_size = os.path.getsize(dest_path)
        if actual_size < min_size:
            print(f"  [WARN] File size ({actual_size} bytes) is smaller than expected ({min_size} bytes).")
    except Exception as e:
        print(f"\n  [FAIL] Download failed: {e}")
        print("\n================ MANUAL DOWNLOAD INSTRUCTIONS ================")
        print(f"1. Open your browser and navigate to:\n   {url}")
        print(f"2. Save the downloaded file as:\n   {dest_path}")
        print("===============================================================\n")

def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    models_dir = os.path.join(base_dir, "../backend/models")
    os.makedirs(models_dir, exist_ok=True)

    print("==================================================")
    print("      AttendChain AI Models Downloader            ")
    print("==================================================")

    all_present = True
    for filename, info in MODELS.items():
        dest = os.path.join(models_dir, filename)
        if os.path.exists(dest) and os.path.getsize(dest) >= info["min_size_bytes"]:
            print(f"[FOUND] {info['description']} is already present ({os.path.getsize(dest):,} bytes).")
        else:
            download_file(info["url"], dest, info["description"], info["min_size_bytes"])
            if not os.path.exists(dest) or os.path.getsize(dest) < info["min_size_bytes"]:
                all_present = False

    print("==================================================")
    if all_present:
        print("[SUCCESS] All AI model files are ready in backend/models/!")
    else:
        print("[NOTICE] Some models could not be downloaded automatically.")
        print("         Follow the manual download instructions above.")

if __name__ == "__main__":
    main()
