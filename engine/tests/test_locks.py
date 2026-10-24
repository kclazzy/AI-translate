import threading

import numpy as np

from app.inpainting import inpaint_or_fill


class _Slow:
    def __init__(self):
        self.calls = 0

    def inpaint(self, rgb, mask):
        self.calls += 1
        return rgb


def test_plain_background_is_filled_without_waiting_for_the_redraw_lock():
    rgb = np.full((40, 40, 3), 250, np.uint8)
    rgb[15:25, 15:25] = 0  # the letters
    mask = np.zeros((40, 40), np.uint8)
    mask[14:26, 14:26] = 1
    lock = threading.Lock()
    inp = _Slow()
    lock.acquire()  # another page is being redrawn by LaMa right now
    try:
        out = inpaint_or_fill(rgb, mask, inp, lock)
    finally:
        lock.release()
    assert inp.calls == 0
    assert int(out[20, 20, 0]) == 250


def test_art_waits_for_its_turn_and_goes_to_the_network():
    rng = np.random.default_rng(1)
    rgb = rng.integers(0, 255, (40, 40, 3), dtype=np.uint8)
    mask = np.zeros((40, 40), np.uint8)
    mask[14:26, 14:26] = 1
    lock = threading.Lock()
    inp = _Slow()
    inpaint_or_fill(rgb, mask, inp, lock)
    assert inp.calls == 1
    assert not lock.locked()
