class SystemHealthMonitor {
    constructor() {
        this.updateInterval = 10000;
        this.timeoutId = null;
        this.isMonitoring = false;
    }

    init() {
        this.createDashboard();
        this.startMonitoring();
    }

    createDashboard() {
        const dashboard = document.createElement('div');
        dashboard.id = 'system-health-dashboard';
        dashboard.innerHTML = `
      <div class="health-compact">
        <p class="health-title">
          <i class="fa-solid fa-gauge-high"></i> System Health Monitor
        </p>
        <div class="health-item">
          <i class="fa-solid fa-microchip"></i>
          <span class="health-label">CPU:</span>
          <span class="health-value" id="cpu-compact">0%</span>
        </div>
        <div class="health-item">
          <i class="fa-solid fa-memory"></i>
          <span class="health-label">RAM:</span>
          <span class="health-value" id="memory-compact">0%</span>
        </div>
        <div class="health-item">
          <i class="fa-solid fa-hard-drive"></i>
          <span class="health-label">Disk:</span>
          <span class="health-value" id="disk-compact">0%</span>
        </div>
        <div class="health-item">
          <i class="fa-solid fa-list-check"></i>
          <span class="health-label">Queue:</span>
          <span class="health-value" id="queue-compact">0</span>
        </div>
        <div class="health-item">
          <i class="fa-solid fa-clock"></i>
          <span class="health-label">Uptime:</span>
          <span class="health-value" id="uptime-compact">0s</span>
        </div>
        <div class="health-item">
          <i class="fa-solid fa-network-wired"></i>
          <span class="health-label">Network:</span>
          <span class="health-value" id="network-compact">0 KB/s</span>
        </div>
      </div>
    `;

        const placeholder = document.getElementById('system-health-placeholder');
        if (placeholder) {
            placeholder.appendChild(dashboard);
        } else {

            const container = document.querySelector('.container');
            container.insertBefore(dashboard, container.firstChild);
        }
    }

    async fetchHealthData() {
        if (document.hidden) return;

        try {
            const response = await fetch('/api/system-health');
            if (response.ok) {
                const data = await response.json();
                this.updateDashboard(data);
            }
        } catch (error) {
            console.error('Error fetching health data:', error);
        }
    }

    updateDashboard(data) {

        const cpuLoad = parseFloat(data.cpu.currentLoad);
        const cpuEl = document.getElementById('cpu-compact');
        cpuEl.textContent = cpuLoad.toFixed(1) + '%';
        cpuEl.className = 'health-value ' + this.getStatusClass(cpuLoad);

        const memPercent = parseFloat(data.memory.percentUsed);
        const memEl = document.getElementById('memory-compact');
        memEl.textContent = memPercent.toFixed(1) + '%';
        memEl.className = 'health-value ' + this.getStatusClass(memPercent);

        const diskPercent = parseFloat(data.disk.percentUsed);
        const diskEl = document.getElementById('disk-compact');
        diskEl.textContent = diskPercent.toFixed(1) + '%';
        diskEl.className = 'health-value ' + this.getStatusClass(diskPercent);

        const queueEl = document.getElementById('queue-compact');
        queueEl.textContent = `${data.queue.active}/${data.queue.total}`;
        queueEl.className = 'health-value';

        const networkSpeed = data.network.rx_sec + data.network.tx_sec;
        const networkEl = document.getElementById('network-compact');
        networkEl.textContent = this.formatBytes(networkSpeed) + '/s';
        networkEl.className = 'health-value';

        const uptimeEl = document.getElementById('uptime-compact');
        uptimeEl.textContent = data.system.uptime;
        uptimeEl.className = 'health-value';
    }

    getStatusClass(value) {
        if (value < 60) return 'status-good';
        if (value < 80) return 'status-warning';
        return 'status-danger';
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    startMonitoring() {
        if (this.isMonitoring) return;
        this.isMonitoring = true;

        const run = async () => {
            if (!this.isMonitoring) return;
            await this.fetchHealthData();
            this.timeoutId = setTimeout(run, this.updateInterval);
        };

        run();

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                if (this.timeoutId) clearTimeout(this.timeoutId);
            } else {
                if (this.isMonitoring) run();
            }
        });
    }

    stopMonitoring() {
        this.isMonitoring = false;
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const healthMonitor = new SystemHealthMonitor();
    healthMonitor.init();
});
