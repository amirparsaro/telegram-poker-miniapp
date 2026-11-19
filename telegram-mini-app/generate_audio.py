import wave
import math
import struct
import os

AUDIO_DIR = os.path.join(os.path.dirname(__file__), "static", "audio")
os.makedirs(AUDIO_DIR, exist_ok=True)
SAMPLE_RATE = 44100

def write_wav(filename, samples):
    filepath = os.path.join(AUDIO_DIR, filename)
    with wave.open(filepath, "w") as wav_file:
        wav_file.setnchannels(1)  # Mono
        wav_file.setsampwidth(2)  # 16-bit
        wav_file.setframerate(SAMPLE_RATE)
        # Pack samples to signed 16-bit integers
        packed = struct.pack(f"<{len(samples)}h", *samples)
        wav_file.writeframes(packed)
    print(f"Generated {filepath} ({len(samples)} samples)")

def clamp_sample(val):
    return max(-32767, min(32767, int(val * 32767)))

# 1. Card Deal Sound (snappy card snap/swish, 150ms)
def gen_card():
    duration = 0.16
    n = int(SAMPLE_RATE * duration)
    samples = []
    for i in range(n):
        t = i / SAMPLE_RATE
        env = math.exp(-t * 28.0)
        # Frequency drop from 600Hz to 120Hz
        freq = 600 - (t / duration) * 480
        val = math.sin(2 * math.pi * freq * t) * env * 0.8
        # Add slight crisp white noise friction
        noise = (math.sin(i * 12345.67) % 1.0 - 0.5) * env * 0.4
        samples.append(clamp_sample(val + noise))
    write_wav("card.wav", samples)

# 2. Chips Sound (two distinct ceramic/metallic chip clacks, 220ms)
def gen_chips():
    duration = 0.24
    n = int(SAMPLE_RATE * duration)
    samples = []
    for i in range(n):
        t = i / SAMPLE_RATE
        # First clack at t=0
        env1 = math.exp(-t * 38.0)
        c1 = (math.sin(2 * math.pi * 2100 * t) + 0.5 * math.sin(2 * math.pi * 3200 * t)) * env1 * 0.7
        # Second clack at t=0.06
        t2 = t - 0.06
        c2 = 0.0
        if t2 > 0:
            env2 = math.exp(-t2 * 40.0)
            c2 = (math.sin(2 * math.pi * 2500 * t2) + 0.6 * math.sin(2 * math.pi * 3800 * t2)) * env2 * 0.8
        samples.append(clamp_sample(c1 + c2))
    write_wav("chips.wav", samples)

# 3. Fold Sound (soft sliding table thump, 220ms)
def gen_fold():
    duration = 0.22
    n = int(SAMPLE_RATE * duration)
    samples = []
    for i in range(n):
        t = i / SAMPLE_RATE
        env = math.exp(-t * 18.0)
        freq = 180 - (t / duration) * 120
        val = math.sin(2 * math.pi * freq * t) * env * 0.85
        samples.append(clamp_sample(val))
    write_wav("fold.wav", samples)

# 4. Community Card Reveal Sound (harmonic chime, 350ms)
def gen_community():
    duration = 0.38
    n = int(SAMPLE_RATE * duration)
    samples = []
    freqs = [523.25, 659.25, 783.99] # C5, E5, G5
    for i in range(n):
        t = i / SAMPLE_RATE
        val = 0.0
        for idx, f in enumerate(freqs):
            t_note = t - idx * 0.05
            if t_note > 0:
                env = math.exp(-t_note * 9.0)
                val += math.sin(2 * math.pi * f * t_note) * env * 0.35
        samples.append(clamp_sample(val))
    write_wav("community.wav", samples)

# 5. Win Fanfare Sound (victorious arpeggio chime, 750ms)
def gen_win():
    duration = 0.75
    n = int(SAMPLE_RATE * duration)
    samples = []
    chord = [523.25, 659.25, 783.99, 1046.50] # C5, E5, G5, C6
    for i in range(n):
        t = i / SAMPLE_RATE
        val = 0.0
        for idx, f in enumerate(chord):
            t_note = t - idx * 0.11
            if t_note > 0:
                env = math.exp(-t_note * 5.0)
                val += math.sin(2 * math.pi * f * t_note) * env * 0.32
        samples.append(clamp_sample(val))
    write_wav("win.wav", samples)

if __name__ == "__main__":
    gen_card()
    gen_chips()
    gen_fold()
    gen_community()
    gen_win()
    print("All audio files generated successfully!")
