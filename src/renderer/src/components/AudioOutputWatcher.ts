export class AudioOutputWatcher {
  private knownDeviceIds = new Set<string>();

  constructor(private onOutputLost: () => void) {
    this.init();
  }

  private async init() {
    await this.refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', this.handleChange);
  }

  private async refreshDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    this.knownDeviceIds = new Set(
      devices.filter(d => d.kind === 'audiooutput').map(d => d.deviceId)
    );
  }

  private handleChange = async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const currentIds = new Set(
      devices.filter(d => d.kind === 'audiooutput').map(d => d.deviceId)
    );

    // a device present before is now gone -> something disconnected
    const lost = [...this.knownDeviceIds].some(id => !currentIds.has(id));

    this.knownDeviceIds = currentIds;

    if (lost) this.onOutputLost();
  };

  destroy() {
    navigator.mediaDevices.removeEventListener('devicechange', this.handleChange);
  }
}