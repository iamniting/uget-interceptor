#!/bin/sh

# Set default umask permissions
umask 022

echo "Installing uget-integrator"

# Remove old files if exist
sudo rm -f /usr/bin/uget-integrator

# Download uget-integrator to /usr/bin/uget-integrator
sudo wget --quiet --output-document /usr/bin/uget-integrator \
    https://raw.githubusercontent.com/iamniting/uget-interceptor/refs/heads/main/integrator/bin/uget-integrator

# Make the uget-integrator executable
sudo chmod +x /usr/bin/uget-integrator

# Create the required directories for native messaging host configuration
sudo mkdir -p /etc/opt/chrome/native-messaging-hosts

# Remove old files if exist
sudo rm -f /etc/opt/chrome/native-messaging-hosts/com.ugetdm.chrome.json

# Download com.ugetdm.chrome.json to /etc/opt/chrome/native-messaging-hosts/com.ugetdm.chrome.json
sudo wget --quiet --output-document /etc/opt/chrome/native-messaging-hosts/com.ugetdm.chrome.json \
    https://raw.githubusercontent.com/iamniting/uget-interceptor/refs/heads/main/integrator/conf/com.ugetdm.chrome.json

echo "uget-integrator is installed successfully!"
echo "Please install the extension and restart the browser"
