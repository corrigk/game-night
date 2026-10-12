import type { Recap } from '../tv/awards';

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Draw a shareable 1080-wide summary card and return it as a PNG. */
export async function renderRecapImage(recap: Recap): Promise<Blob> {
  const W = 1080;
  const font = "'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',system-ui,sans-serif";
  const medals = ['🥇', '🥈', '🥉'];
  const date = new Date(recap.at).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  // First pass measures height, second draws.
  const draw = (ctx: CanvasRenderingContext2D, measureOnly: boolean): number => {
    let y = 90;
    const text = (s: string, x: number, size: number, color: string, weight = '800', align: CanvasTextAlign = 'left') => {
      if (measureOnly) return;
      ctx.font = `${weight} ${size}px ${font}`;
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.fillText(s, x, y);
    };
    text('🎉 GAME NIGHT', W / 2, 74, '#ffffff', '900', 'center');
    y += 56;
    text(date, W / 2, 34, '#c9bff0', '600', 'center');
    y += 40;
    if (recap.games.length) {
      ctx.font = `600 28px ${font}`;
      for (const l of wrap(ctx, recap.games.join(' · '), W - 160)) {
        text(l, W / 2, 28, '#9d94c9', '600', 'center');
        y += 36;
      }
    }
    y += 30;

    text('FINAL STANDINGS', 70, 34, '#ff7be5', '900');
    y += 28;
    recap.players.slice(0, 8).forEach((p, i) => {
      y += 56;
      if (!measureOnly) {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(95, y - 14, 24, 0, Math.PI * 2);
        ctx.fill();
      }
      text(p.emoji, 95, 28, '#000000', '400', 'center');
      text(`${medals[i] ?? `${i + 1}.`} ${p.name}`, 140, 40, '#ffffff', i < 3 ? '900' : '700');
      text(p.score.toLocaleString(), W - 70, 40, '#7dffb0', '900', 'right');
    });
    y += 50;

    if (recap.teams.length) {
      text('TEAMS', 70, 34, '#ff7be5', '900');
      y += 10;
      for (const t of recap.teams) {
        y += 50;
        text(`${t.emoji} ${t.name}`, 70, 38, '#ffffff', '800');
        text(t.total.toLocaleString(), W - 70, 38, '#7dffb0', '900', 'right');
      }
      y += 50;
    }

    if (recap.awards.length) {
      text('AWARDS', 70, 34, '#ff7be5', '900');
      y += 10;
      for (const a of recap.awards.slice(0, 8)) {
        y += 52;
        text(`${a.emoji} ${a.title}`, 70, 36, '#ffd36e', '800');
        y += 40;
        text(a.names.join(' & '), 100, 34, '#ffffff', '800');
        y += 6;
      }
      y += 36;
    }

    if (recap.moments.length) {
      text('BEST MOMENTS', 70, 34, '#ff7be5', '900');
      y += 10;
      for (const m of recap.moments) {
        y += 52;
        text(`${m.emoji} ${m.title}`, 70, 34, '#ffd36e', '800');
        ctx.font = `700 32px ${font}`;
        for (const l of wrap(ctx, `${m.text} — ${m.by}`, W - 170)) {
          y += 42;
          text(l, 100, 32, '#ffffff', '700');
        }
        y += 6;
      }
    }
    return y + 80;
  };

  const probe = document.createElement('canvas').getContext('2d')!;
  const H = Math.max(900, draw(probe, true));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#2a0b4d');
  g.addColorStop(1, '#06274a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  draw(ctx, false);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not render image'))), 'image/png'));
}
