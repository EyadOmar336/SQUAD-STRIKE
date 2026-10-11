CREATE TABLE IF NOT EXISTS strike_voice_signals (
  id BIGSERIAL PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES strike_rooms(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES strike_players(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES strike_players(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('offer', 'answer', 'ice')),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS strike_voice_signals_recipient_idx
  ON strike_voice_signals (room_id, recipient_id, id);
CREATE INDEX IF NOT EXISTS strike_voice_signals_expiry_idx
  ON strike_voice_signals (expires_at);
