function uploadCSVToDB() {
  return new Promise((resolve, reject) => {
    const csvFolderPath = "/Users/kimsungah/Desktop/SmartTalentMatcher/csv";
    fs.readdir(csvFolderPath, (err, files) => {
      if (err) return reject(err);
      const csvFiles = files.filter(file => file.endsWith(".csv"));
      if (csvFiles.length === 0) {
        console.log("No CSV files found in folder:", csvFolderPath);
        return resolve();
      }
      BulkEmailRecipient.deleteMany({})
        .then(() => {
          let filesProcessed = 0;
          csvFiles.forEach(file => {
            const filePath = path.join(csvFolderPath, file);
            fs.createReadStream(filePath)
              .pipe(csvParser())
              .on("data", (row) => {
                if (row.email) {
                  BulkEmailRecipient.updateOne(
                    { email: row.email.trim() },
                    { email: row.email.trim() },
                    { upsert: true }
                  ).catch(err => console.error("Error upserting email:", err));
                }
              })
              .on("end", () => {
                filesProcessed++;
                if (filesProcessed === csvFiles.length) {
                  console.log("CSV files uploaded to DB.");
                  resolve();
                }
              })
              .on("error", (err) => reject(err));
          });
        })
        .catch(err => reject(err));
    });
  });
}