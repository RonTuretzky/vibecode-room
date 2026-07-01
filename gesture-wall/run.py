#!/usr/bin/env python3
"""Entry point. Examples:

    python run.py                       # camera-free mouse test mode
    python run.py --source pose         # webcam + MediaPipe pose tracking
    python run.py --source pose --calibrate   # calibrate corners first
    python run.py --rows 3 --cols 4 --dwell 1.0
"""

from gesturewall.app import main

if __name__ == "__main__":
    main()
