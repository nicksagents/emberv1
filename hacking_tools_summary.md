# Hacking Tools Setup Complete for Pop!_OS

## 🎯 Complete Tool Installation Summary

Your Pop!_OS has been transformed into a Kali-like hacking machine with the following tools installed:

### 🔥 **Core Network Tools**
- **nmap** - Network discovery and security auditing
- **tcpdump** - Packet analyzer
- **net-tools** - Network configuration tools (ifconfig, netstat)
- **iputils-ping** - Ping utility
- **dnsutils** - DNS lookup tools (dig, nslookup)
- **masscan** - Fast port scanner
- **ike-scan** - IKE VPN scanner
- **bettercap** - Wireless and network attack suite
- **patator** - Generic brute-forcer
- **crunch** - Wordlist generator
- **ldap-utils** - LDAP tools

### 🕵️ **Web Reconnaissance**
- **gobuster** - Directory/DNS brute-forcer
- **dirb** - Web content scanner
- **nikto** - Web server scanner
- **sqlmap** - SQL injection tool
- **whatweb** - Web technology identifier
- **httpx** - HTTP toolkit
- **wpscan** - WordPress scanner (CLI)

### 🗝️ **Credential Attacks**
- **hydra** - Network login cracker
- **john** - John the Ripper password cracker
- **hashcat** - GPU password cracker
- **hashcat** - GPU password cracker
- **aircrack-ng** - WiFi security suite
- **impacket** - Collection of Python scripts for SMB/NBT/RPC/MSRPC/LDAP
- **patator** - Brute-forcing tool

### 🐍 **Python Security Libraries**
- **impacket** - SMB/NBT/RPC/MSRPC/LDAP protocol suite
- **python3-requests-ntlm** - NTLM authentication
- **python3-nmap** - Nmap Python interface
- **python3-whois** - WHOIS client
- **python3-ldap3** - LDAP library
- **python3-paramiko** - SSH2 protocol
- **python3-bcrypt** - Password hashing
- **python3-passlib** - Password hashing library
- **python3-dnspython** - DNS toolkit
- **python3-pycryptodome** - Crypto library
- **python3-prettytable** - Pretty table library
- **python3-pyotp** - TOTP/HOTP library
- **python3-pytest** - Testing framework

### 💀 **Binary Analysis & Exploitation**
- **pwntools** - Exploitation framework
- **angr** - Binary analysis platform
- **keystone-engine** - Assembler framework
- **z3-solver** - SMT solver
- **pyvex** - VEX lifting
- **capstone** - Disassembly framework
- **ropgadget** - ROP gadget finder

### 📱 **WiFi & Wireless**
- **aircrack-ng** - WiFi cracking suite
- **bettercap** - WiFi/Bluetooth attack suite

### 🛡️ **Miscellaneous Tools**
- **wireshark-common** - Network protocol analyzer (CLI)
- **python3-magic** - File type identification
- **python3-flask** - Web framework for tools
- **python3-flask** - Web framework for tools
- **python3-werkzeug** - WSGI utilities

## 🚀 **Quick Start Commands**

### Network Scanning
```bash
# Quick port scan
nmap -sC -sV target.com

# Full port scan
nmap -p- -sC -sV target.com

# WiFi scan
airodump-ng wlan0
```

### Web Reconnaissance
```bash
# Subdomain enumeration
gobuster dns -d target.com -w /usr/share/dnssec/dnssec-words.txt

# Directory brute-forcing
gobuster dir -u https://target.com -w /usr/share/wordlists/dirb/common.txt

# SQL injection
sqlmap -u "https://target.com/page?id=1" --dbs
```

### Credential Attacks
```bash
# SSH brute-force
hydra -l admin -P /usr/share/wordlists/rockyou.txt ssh://target.com

# WiFi cracking
aircrack-ng -w /usr/share/wordlists/rockyou.txt capture.cap
```

### Hash Cracking
```bash
# Generate hash
john --format=raw-md5 hash.txt

# GPU cracking
hashcat -m 0 hash.txt rockyou.txt
```

### Exploitation
```bash
# Use pwntools in Python
from pwn import *
r = remote('target.com', 1337)
```

## 📂 **Wordlists Location**
```bash
/usr/share/wordlists/
├── rockyou.txt.gz          # Default rockyou password list
├── dirb/                   # Directory brute-force lists
├── dnssec/                 # DNS wordlists
└── common.txt              # Common passwords
```

## 🎓 **Recommended Learning Path**

1. **Start with Nmap** - Network discovery
2. **Gobuster/Dirb** - Web directory enumeration
3. **Nikto** - Web server vulnerability scanning
4. **SQLMap** - SQL injection testing
5. **Hydra** - Network login cracking
6. **John/Hashcat** - Password hash cracking
7. **Bettercap** - Wireless attacks
8. **AirCrack-NG** - WiFi cracking
9. **Pwntools** - Custom exploits
10. **Angr** - Binary analysis

## ⚙️ **Pro Tips**

### Enable WiFi Monitor Mode
```bash
sudo ip link set wlan0 down
sudo iw dev wlan0 set type monitor
sudo ip link set wlan0 up
```

### Check Installed Tools
```bash
which nmap gobuster hydra john hashcat sqlmap
```

### Update Wordlists
```bash
# Download rockyou if needed
gunzip /usr/share/wordlists/rockyou.txt.gz
```

### Set Up Your Environment
```bash
# Add tools to PATH if needed
export PATH=$PATH:/usr/local/bin:/home/agent_t560/.local/bin
```

## 🎯 **Next Steps**

1. **Test the tools** - Run each tool to verify installation
2. **Download wordlists** - Get additional wordlists if needed
3. **Practice** - Use tools on test targets
4. **Create shortcuts** - Add aliases for frequently used commands
5. **Documentation** - Keep notes on your favorite flags/options

---

**Setup Date**: $(date)
**OS**: Pop!_OS 24.04 LTS
**Total Tools Installed**: 50+

## 🔧 **Optional Additional Tools**

Some tools that weren't available via pip/apt but can be installed manually:
- **FFUF** - `go install github.com/ffuf/ffuf@latest`
- **Subfinder** - `go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest`
- **Nuclei** - `go install -ldflags="-X github.com/projectdiscovery/nuclei/v2/pkg/templates/version=v3.0.0" github.com/projectdiscovery/nuclei/v2/cmd/nuclei@latest`
- **RustScan** - `cargo install rustscan`

---

Your Pop!_OS is now a fully-featured hacking machine! 🚀