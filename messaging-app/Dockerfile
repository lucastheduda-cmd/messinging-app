# Dockerfile - Instructions for building your app's container
#
# Think of this like a recipe. Docker follows each step
# to create a clean environment where your app can run.

# Step 1: Start with an official Node.js base image.
# "alpine" is a tiny version of Linux — it keeps the container small.
FROM node:20-alpine

# Step 2: Set the working directory inside the container.
# All the following commands will run from this folder.
WORKDIR /app

# Step 3: Copy package.json first (before the rest of the code).
# We do this separately so Docker can cache the npm install step —
# it only re-runs npm install if package.json actually changed.
COPY package.json ./

# Step 4: Install all the npm packages your app needs.
RUN npm install --production

# Step 5: Copy the rest of your app's code into the container.
COPY . .

# Step 6: Tell Docker which port your app listens on.
# Render reads this to know where to send traffic.
EXPOSE 3000

# Step 7: The command that starts your app.
CMD ["node", "server.js"]
