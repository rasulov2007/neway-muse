"""Voice-over for the hackathon film: one file per line of scripts/hackathon/vo-lines.json.

    python scripts/hackathon/tts.py [--voice en-US-AndrewNeural] [--uz-voice uz-UZ-SardorNeural] [--out DIR] [--rate +0%]

Microsoft neural voices through edge-tts (owner approved). Writes <id>.mp3 into
docs/hackathon/video/tts/<voice>/ (git-ignored media). Re-running skips files that exist.
"""
import argparse
import asyncio
import json
import os

import edge_tts

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--voice', default='en-US-AndrewNeural')
    ap.add_argument('--uz-voice', default='uz-UZ-SardorNeural')
    ap.add_argument('--rate', default='+0%')
    ap.add_argument('--out', default=None)
    ap.add_argument('--only', default=None, help='comma list of ids')
    a = ap.parse_args()
    lines = json.load(open(os.path.join(HERE, 'vo-lines.json'), encoding='utf-8'))['lines']
    out = a.out or os.path.join(ROOT, 'docs', 'hackathon', 'video', 'tts', a.voice)
    os.makedirs(out, exist_ok=True)
    only = set(a.only.split(',')) if a.only else None
    for line in lines:
        if only and line['id'] not in only:
            continue
        target = os.path.join(out, line['id'] + '.mp3')
        if os.path.exists(target):
            continue
        voice = a.uz_voice if line.get('lang') == 'uz' else a.voice
        rate = '-8%' if line.get('lang') == 'uz' else a.rate
        # The service now and then answers with no audio: try again, a few seconds apart.
        for attempt in range(6):
            try:
                await edge_tts.Communicate(line['text'], voice, rate=rate).save(target)
                if os.path.getsize(target) > 0:
                    break
            except edge_tts.exceptions.NoAudioReceived:
                pass
            if os.path.exists(target):
                os.remove(target)
            await asyncio.sleep(3 + attempt * 2)
        print('wrote' if os.path.exists(target) else 'FAILED', target)


asyncio.run(main())
