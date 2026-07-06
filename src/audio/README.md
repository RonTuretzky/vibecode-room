# Audio Output Defaults

The audio hot plane is deterministic and provider-free for earcons and route
acks. Layer A earcons and Layer B acks are pre-rendered PCM clips dispatched
directly to `AudioOutput.playPcm`.

Environment-tunable defaults:

- `VIBERSYN_EARCON_SAMPLE_RATE_HZ`: `24000`
- `VIBERSYN_EARCON_VOLUME`: `0.18`
- `VIBERSYN_EARCON_MAX_LATENCY_MS`: `300`
- `VIBERSYN_OUTPUT_MAX_WORDS`: `15`
- `VIBERSYN_OUTPUT_SILENCE_TARGET`: `0.9`
- `VIBERSYN_OUTPUT_ROUND_TRIP_BUDGET_MS`: `1500`
- `VIBERSYN_OUTPUT_WORKING_ACK_REPEAT_MS`: `1500`

Fixed state phrases pre-cached through the configured TTS provider are:
`Ready`, `Muted`, `Unmuted`, `Working`, and `Halted`.
