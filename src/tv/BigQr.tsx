import { QRCodeSVG } from 'qrcode.react';
import { joinUrl } from './TVScreens';

/** Full-screen join code for latecomers. Click anywhere, or press Q / Esc, to dismiss. */
export function BigQr({ code, onClose }: { code: string; onClose: () => void }) {
  return (
    <div className="bigqr" onClick={onClose} role="dialog" aria-label="Join code">
      <div className="bigqr-card">
        <p className="bigqr-label">Scan to join</p>
        <div className="bigqr-code">
          <QRCodeSVG value={joinUrl(code)} size={1024} marginSize={2} bgColor="#ffffff" fgColor="#000000" />
        </div>
        <div className="bigqr-room">{code}</div>
        <p className="bigqr-url">{window.location.host}/play</p>
        <p className="dim">Click anywhere or press <kbd>Q</kbd> to close</p>
      </div>
    </div>
  );
}
