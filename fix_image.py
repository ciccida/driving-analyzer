from PIL import Image

def process_mascot(input_path, output_path):
    img = Image.open(input_path).convert("RGBA")
    
    # Crop 12 pixels from all edges to remove screenshot artifacts
    w, h = img.size
    img = img.crop((12, 12, w - 12, h - 12))
    
    datas = img.getdata()
    newData = []
    for item in datas:
        # replace white (or very light gray) with transparent
        if item[0] > 220 and item[1] > 220 and item[2] > 220:
            newData.append((255, 255, 255, 0))
        else:
            newData.append(item)
            
    img.putdata(newData)
    img.save(output_path, "PNG")

process_mascot("/Users/kentachida/.gemini/antigravity/brain/ca8fe15a-b537-47e5-91a5-9826ce4804b7/.user_uploaded/media_1787282219073.png", "public/cruise-mascot.png")
