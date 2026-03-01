import os
import io
import struct
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

from openai import OpenAI

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])

VOICE = "nova"
MODEL = "gpt-4o-mini-tts"
SPEED = 0.88
from config import MEDITATIONS_DIR

OUTPUT_DIR = MEDITATIONS_DIR
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

INSTRUCTIONS = (
    "You are narrating a deeply personal guided meditation. "
    "Speak slowly, warmly, and gently — like a calm, trusted presence sitting beside the listener. "
    "Leave natural pauses between sentences. Let the words breathe. "
    "Your tone should be intimate and grounded, not performative or overly soothing. "
    "Speak as if you truly know this person. Because you do."
)

SEGMENTS = [
    {
        "text": (
            "Close your eyes. "
            "Let your hands rest wherever they are. "
            "Feel the weight of your body. "
            "The chair beneath you. "
            "Your feet on the ground. "
            "You don't need to do anything right now. "
            "You don't need to be anything right now. "
            "Just breathe."
        ),
        "pause_after": 4.0,
    },
    {
        "text": (
            "Breathe in through your nose. Two. Three. Four. "
            "And out, slowly. Two. Three. Four. Five. Six. "
            "Again. In. Two. Three. Four. "
            "And a long, slow exhale. Two. Three. Four. Five. Six. Seven. Eight. "
            "Let the exhale be longer than the inhale. "
            "Your body already knows how to do this."
        ),
        "pause_after": 5.0,
    },
    {
        "text": (
            "Now bring your attention to the base of your skull. "
            "That place you've been feeling all week. "
            "The place where the energy lives. "
            "Don't try to change it. Just notice it. "
            "Whatever is there — warmth, buzzing, stillness — it belongs to you. "
            "Your body has been learning something new this week. "
            "It's been learning how to let go of what it's held for twenty-eight years. "
            "Three times in three days, it found the way. "
            "It knows the path now."
        ),
        "pause_after": 5.0,
    },
    {
        "text": (
            "And if the sentinel is there — "
            "scanning, watching, generating its warnings — "
            "you can speak to it now. "
            "Not with force. Not with fear. "
            "Just with knowing."
        ),
        "pause_after": 3.0,
    },
    {
        "text": (
            "You know exactly who it is. "
            "You know exactly what it's afraid of. "
            "It was installed in a dark bedroom by a silhouette who loved you "
            "but didn't know what he was putting in place. "
            "It's been running ever since — "
            "in squash tournaments, in official matches, at demo days, "
            "at Shabbat dinners, "
            "in every moment where being seen and the outcome mattering "
            "happened at the same time. "
            "It's not your enemy. "
            "It's a nine-year-old's best attempt at protection. "
            "But you're not nine anymore. "
            "And you're not in the dark."
        ),
        "pause_after": 6.0,
    },
    {
        "text": (
            "Your body is doing something extraordinary. "
            "It's digesting. Not food — inheritance. "
            "Everything your parents gave you came as one package. "
            "The Torah. The moral compass. The depth of feeling. "
            "The capacity for connection. "
            "The Jewishness that makes you cry reading Vayikra. "
            "Those are the nutrients. "
            "Your body has already absorbed them. They're yours. "
            "They're not going anywhere."
        ),
        "pause_after": 4.0,
    },
    {
        "text": (
            "But the conditional worth. The shame. "
            "The God who watches from the dark bedroom. "
            "The sentinel. "
            "Those are what the system is learning to release. "
            "You're not rejecting your inheritance. "
            "You're finishing digesting it. "
            "Keeping what nourishes. "
            "Letting the rest move through."
        ),
        "pause_after": 6.0,
    },
    {
        "text": (
            "It's Shabbat. "
            "The day that asks nothing of you. "
            "No building. No proving. No earning your place. "
            "Shabbat doesn't care what your legacy is. "
            "It doesn't ask what you've created or whether anyone is watching. "
            "It just says: rest. You are already enough. "
            "The same tradition that installed the watching God "
            "also gave you this — a day that commands you to stop striving. "
            "That is not a contradiction. That is the inheritance completing itself."
        ),
        "pause_after": 5.0,
    },
    {
        "text": (
            "Last night Candela lit the candles. "
            "A woman who wasn't born into this "
            "chose to bring Shabbat into the room with you. "
            "Not because she had to. "
            "Because she wanted to be part of what matters to you. "
            "Your mother said: of course I accept you. "
            "I can't believe you would ever think otherwise. "
            "Let those words land in your body right now. "
            "Not in your mind, where you've already filed them away. "
            "In your body. Where the nine-year-old lives."
        ),
        "pause_after": 6.0,
    },
    {
        "text": (
            "Tomorrow you fly to Costa Rica. "
            "You're going to see her. "
            "And the sentinel might activate — "
            "at the airport, when you see her face, at dinner with friends. "
            "When it does, you have something now that you didn't have a week ago. "
            "You know its name. You know its origin. "
            "You know what it feels like when it starts to discharge. "
            "And you know it's a program that was installed in you. "
            "Not something you chose."
        ),
        "pause_after": 4.0,
    },
    {
        "text": (
            "She told you: I don't need you to be happy all the time. "
            "She didn't ask for the performing Josh. "
            "She asked for the real one. "
            "The one who calls and says — "
            "I woke up still feeling some of this energy. "
            "I wanted to hear your voice. "
            "That's not being a drag. "
            "That's intimacy."
        ),
        "pause_after": 5.0,
    },
    {
        "text": (
            "Show up real. "
            "The sentinel says: show up perfect, or don't show up at all. "
            "You already know the alternative."
        ),
        "pause_after": 6.0,
    },
    {
        "text": (
            "You once said: "
            "I hope I can come to a place where I can sing "
            "in front of ten thousand people "
            "the way I sing when I'm alone. "
            "That's the whole project. In one sentence. "
            "Not performing despite the freeze. "
            "Not medicating through it. "
            "The freeze not being there. "
            "The playground and the arena being the same place."
        ),
        "pause_after": 4.0,
    },
    {
        "text": (
            "Your voice is already free. "
            "It always has been. "
            "You don't need anything to give it to you. "
            "You just need the thing that takes it away "
            "to stand down. "
            "And it's standing down now. "
            "Slowly. Imperfectly. "
            "But it's standing down."
        ),
        "pause_after": 7.0,
    },
    {
        "text": (
            "So rest here for a moment. "
            "Feel your breath. "
            "Feel the base of your skull. "
            "Feel whatever is moving through you — "
            "tears, warmth, stillness, fear, hope. "
            "You held five emotions at once this morning "
            "and none of them shut the others down. "
            "That's not collapse. That's regulation. "
            "That's what it feels like when the system is processing "
            "instead of clamping."
        ),
        "pause_after": 5.0,
    },
    {
        "text": (
            "You are safe. "
            "Not because nothing can go wrong. "
            "But because you can handle what comes. "
            "You always could. "
            "The nine-year-old just didn't know that yet. "
            "But you do."
        ),
        "pause_after": 5.0,
    },
    {
        "text": (
            "Breathe in. "
            "And let it go."
        ),
        "pause_after": 8.0,
    },
]


def make_silence_wav(duration_sec: float, sample_rate: int = 24000) -> bytes:
    """Generate raw WAV bytes of silence."""
    num_samples = int(sample_rate * duration_sec)
    data = b"\x00\x00" * num_samples  # 16-bit silence
    buf = io.BytesIO()
    # WAV header
    data_size = len(data)
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + data_size))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<I", 16))  # chunk size
    buf.write(struct.pack("<H", 1))   # PCM
    buf.write(struct.pack("<H", 1))   # mono
    buf.write(struct.pack("<I", sample_rate))
    buf.write(struct.pack("<I", sample_rate * 2))  # byte rate
    buf.write(struct.pack("<H", 2))   # block align
    buf.write(struct.pack("<H", 16))  # bits per sample
    buf.write(b"data")
    buf.write(struct.pack("<I", data_size))
    buf.write(data)
    return buf.getvalue()


def generate_meditation():
    from pydub import AudioSegment

    print("Generating meditation audio...\n")
    combined = AudioSegment.empty()

    for i, seg in enumerate(SEGMENTS):
        label = seg["text"][:60].replace("\n", " ")
        print(f"  [{i+1}/{len(SEGMENTS)}] {label}...")

        response = client.audio.speech.create(
            model=MODEL,
            voice=VOICE,
            input=seg["text"],
            instructions=INSTRUCTIONS,
            speed=SPEED,
            response_format="mp3",
        )

        audio_bytes = response.content
        audio_seg = AudioSegment.from_mp3(io.BytesIO(audio_bytes))
        combined += audio_seg

        pause_ms = int(seg["pause_after"] * 1000)
        combined += AudioSegment.silent(duration=pause_ms)

    output_path = OUTPUT_DIR / "meditation_2026-02-28.mp3"
    combined.export(str(output_path), format="mp3", bitrate="192k")
    duration_min = len(combined) / 1000 / 60
    print(f"\nDone. {duration_min:.1f} minutes written to {output_path}")
    return output_path


if __name__ == "__main__":
    generate_meditation()
