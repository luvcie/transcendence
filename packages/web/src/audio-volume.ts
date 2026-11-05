export function volumeToLevel(volume: number) {
  return Math.min(1, volume) + Math.max(0, (volume - 1) / 2);
}

export function levelToVolume(level: number) {
  return Math.min(1, level) + Math.max(0, (level - 1) * 2);
}

export class VolumeSteps {
  private allowBoostAfter: number | null = null;

  step(volume: number, direction: number, now: number) {
    let maximum = 2;
    if (direction > 0 && volume >= 1 && volume < 1.05) {
      if (this.allowBoostAfter === null || now >= this.allowBoostAfter + 3000) this.allowBoostAfter = now + 500;
      if (now < this.allowBoostAfter) maximum = 1;
    }
    return Math.max(0, Math.min(maximum, Math.round((volume + direction * 0.05) * 100) / 100));
  }
}
