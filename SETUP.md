### DIG Node Setup Guide

A DIG Node is a data layer-powered web server that allows you to deploy and manage data and applications. Setting up a DIG Node requires the ability to port forward specific ports to ensure proper functionality. If you're unable to port forward, a future service will allow you to use the data layer without a dedicated DIG Node. This guide is for those who want full control over a DIG Node they own. 

**Requirements:**
- Ability to port forward on your server.
- Some XCH (Chia cryptocurrency) to fund operations.
- Docker installed on the machine where your DIG Node will be hosted.

---

#### Step 1: Create a Dedicated Mnemonic for DIG

The DIG CLI and DIG Node Server require a mnemonic to operate. Although the mnemonic is encrypted and stored, it is **highly recommended** to create a dedicated mnemonic specifically for DIG development. It is also **highly recommended** that you only keep enough balance to run the DIG Node. While the software does its best to keep your seed secure, its ultimately your responsibility to keep your funds safe.

1. **Create a New Wallet Seed:**
   - Open the official Chia UI.
   - Create a new wallet seed and name it `DIGNode`.
   - Fund the wallet with some XCH. While 1 XCH is sufficient for the short term, it is recommended to maintain at least 0.25 XCH.

---

#### Step 2: Install the DIG CLI

The DIG CLI is a tool that you'll need to install on your development machine to interact with your DIG Node.

1. **Install Node.js and NPM:**
   - Ensure that Node.js version 20 and NPM are installed on your machine.

2. **Install DIG CLI:**
   - Run the following command to install the DIG CLI globally:
     ```bash
     npm install dig-cli -g
     ```

---

#### Step 3: Import Your Mnemonic into DIG CLI

After installing the DIG CLI, you need to import the mnemonic you created in Step 1.

1. **Import the Mnemonic:**
   - Run the following command:
     ```bash
     dig keys generate
     ```
   - Choose the option to "Import from Chia client."
   - Ensure that the Chia client is running and you are logged into your new wallet.

---

#### Step 4: Generate Credentials for Your DIG Node

Your DIG Node, referred to as the "remote," will communicate with the DIG CLI using mTLS for security. You'll need a username and password to access the remote.

1. **Generate Credentials:**
   - Run the following command to generate a secure username and password:
     ```bash
     dig generate creds
     ```
   - Save these credentials securely.

2. **Associate Credentials with Remote IP:**
   - If you know the public IP address of your remote, you can associate the credentials with it during this process.

---

#### Step 5: Prepare Your DIG Node Host Machine

You can run the DIG Node on your local machine, but it is highly recommended to use a Linux server that is always on.

1. **Open Required Ports:**
   - Ensure the following ports are open on your host machine:
     - **Port 80:** For the Content Server, which serves data on your DIG Node.
     - **Port 4159:** For the Data Propagation Server, which handles data synchronization between DIG Nodes using mTLS on encrypted channels.

2. **Configure Your Firewall:**
   - Ensure these ports are open in your firewall settings.

---

#### Step 6: Set Up the DIG Node with Docker

Now that your host machine is ready, you can set up the DIG Node using Docker.

1. **Create a Project Folder:**
   - On your DIG Node host machine, create a project folder.

2. **Create `docker-compose.yml`:**
   - Inside the project folder, create a new file named `docker-compose.yml`.
   - Copy the contents from the following link into the file:
     [docker-compose.yml](https://github.com/Datalayer-Storage/dig-cli/blob/main/docker-compose.yml).

3. **Configure Environment Variables:**
   - Use the credentials you generated in Step 4.
   - Set the `DIG_USERNAME` and `DIG_PASSWORD` environment variables in the `docker-compose.yml` file.

4. **Start the DIG Node:**
   - Run the following command to start the DIG Node:
     ```bash
     docker-compose up
     ```

5. **Verify Setup:**
   - Visit `http://your-ip-address` in a web browser.
   - If you see a page with the header "Store Index," your DIG Node is running correctly.

---

#### Step 7: Sync the Mnemonic to Your DIG Node

Finally, you need to sync the mnemonic from your DIG CLI to your DIG Node.

1. **Sync the Mnemonic:**
   - Run the following command to sync the mnemonic using mTLS:
     ```bash
     dig remote sync seed
     ```
   - This command will send the mnemonic to your remote keyring, allowing the remote to manage server coins needed for the DIG Network.

---

By following these steps, you will have successfully set up a DIG Node with a dedicated mnemonic, allowing you to monitor and manage your node's balance easily. This setup ensures that your DIG Node is secure, always accessible, and ready for deploying data and applications.